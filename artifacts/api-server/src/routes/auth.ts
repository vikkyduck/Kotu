import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, sessionsTable } from "@workspace/db";
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
