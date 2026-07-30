import { Router, type IRouter } from "express";
import { randomBytes, createHash } from "node:crypto";
import { eq, and, isNull, gt } from "drizzle-orm";
import { db, usersTable, sessionsTable, passwordResetsTable } from "@workspace/db";
import { sendMail, resetEmail, mailConfigured } from "../lib/mail";
import { logger } from "../lib/logger";
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  hashPassword,
  verifyPassword,
  tooManyAttempts,
  registerFailedAttempt,
  clearAttempts,
} from "../lib/auth";
import { requireAuth } from "../middlewares/require-auth";

const router: IRouter = Router();

// secure-cookie только под HTTPS: на голом HTTP браузер её просто не сохранит,
// поэтому включаем флаг там, где сайт реально отдаётся по https.
const isHttps = (process.env.PUBLIC_BASE_URL ?? "").startsWith("https://");

/** Живая, неиспользованная и не протухшая ссылка сброса — или null. */
async function findValidReset(token: string) {
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const [row] = await db
    .select()
    .from(passwordResetsTable)
    .where(
      and(
        eq(passwordResetsTable.tokenHash, tokenHash),
        isNull(passwordResetsTable.usedAt),
        gt(passwordResetsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

router.post("/auth/login", async (req, res) => {
  const ip = req.ip ?? "unknown";
  if (tooManyAttempts(ip)) {
    res.status(429).json({ message: "Слишком много попыток. Подождите 15 минут." });
    return;
  }

  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!email || !password) {
    res.status(400).json({ message: "Введите почту и пароль" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  // Один и тот же ответ для «нет такого пользователя» и «неверный пароль»,
  // чтобы по ответу нельзя было перебирать существующие адреса.
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) {
    registerFailedAttempt(ip);
    res.status(401).json({ message: "Неверная почта или пароль" });
    return;
  }

  clearAttempts(ip);
  const { token, expiresAt } = await createSession(user.id);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps,
    expires: expiresAt,
    path: "/",
  });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

router.post("/auth/logout", async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) await destroySession(token);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.status(204).end();
});

router.get("/me", requireAuth, (req, res) => {
  const user = req.user!;
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

/**
 * Забыли пароль. Ответ ВСЕГДА одинаковый, даже если такой почты нет:
 * иначе форму можно использовать, чтобы проверять, кто зарегистрирован.
 */
router.post("/auth/forgot", async (req, res) => {
  const ip = req.ip ?? "unknown";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";

  // Единый ответ отдаём сразу, а письмо шлём фоном: по времени ответа тоже
  // не должно быть видно, нашёлся пользователь или нет.
  res.json({ ok: true });

  if (email === "" || tooManyAttempts(ip)) return;
  registerFailedAttempt(ip);

  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user) return;

    if (!mailConfigured()) {
      logger.error({ email }, "Запрошен сброс пароля, но почта не настроена");
      return;
    }

    const token = randomBytes(32).toString("hex");
    await db.insert(passwordResetsTable).values({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const base = (process.env["PUBLIC_BASE_URL"] ?? "").replace(/\/+$/, "");
    const link = `${base}/?reset=${token}`;
    const { subject, text, html } = resetEmail(user.name, link);
    await sendMail(user.email, subject, text, html);
  } catch (err) {
    logger.error({ err }, "Не удалось отправить письмо со сбросом пароля");
  }
});

/** Проверка ссылки перед показом формы — чтобы не просить пароль впустую. */
router.get("/auth/reset/check", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const row = token ? await findValidReset(token) : null;
  res.json({ valid: Boolean(row) });
});

router.post("/auth/reset", async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (password.length < 10) {
    res.status(400).json({ message: "Пароль должен быть не короче 10 символов" });
    return;
  }

  const row = await findValidReset(token);
  if (!row) {
    res.status(400).json({ message: "Ссылка устарела или уже использована. Запросите новую." });
    return;
  }

  await db
    .update(usersTable)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(usersTable.id, row.userId));

  // Ссылка одноразовая, и все прежние входы обрываются: если пароль забыт
  // из-за того, что в аккаунт кто-то залез, его сессия тоже должна умереть.
  await db
    .update(passwordResetsTable)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetsTable.tokenHash, row.tokenHash));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, row.userId));

  res.json({ ok: true });
});

router.post("/auth/password", requireAuth, async (req, res) => {
  const user = req.user!;
  const current = typeof req.body?.current === "string" ? req.body.current : "";
  const next = typeof req.body?.next === "string" ? req.body.next : "";

  if (next.length < 10) {
    res.status(400).json({ message: "Новый пароль короче 10 символов" });
    return;
  }
  if (next === current) {
    res.status(400).json({ message: "Новый пароль совпадает со старым" });
    return;
  }

  const ok = await verifyPassword(current, user.passwordHash);
  if (!ok) {
    registerFailedAttempt(req.ip ?? "unknown");
    res.status(401).json({ message: "Текущий пароль неверен" });
    return;
  }

  await db
    .update(usersTable)
    .set({ passwordHash: await hashPassword(next) })
    .where(eq(usersTable.id, user.id));

  // Смена пароля обрывает все сессии — и на других устройствах тоже.
  // Если пароль меняют из-за подозрения на утечку, чужой доступ должен умереть.
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, user.id));

  const { token, expiresAt } = await createSession(user.id);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps,
    expires: expiresAt,
    path: "/",
  });
  res.json({ ok: true });
});

export default router;
