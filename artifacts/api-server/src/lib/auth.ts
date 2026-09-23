import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { isIPv4, isIPv6 } from "node:net";
import { eq, lt } from "drizzle-orm";
import { db, usersTable, sessionsTable, type User } from "@workspace/db";

const scryptAsync = promisify(scrypt);

const KEY_LEN = 64;
const SESSION_DAYS = 30;

export const SESSION_COOKIE = "kot_session";

/** "salt:hash" в hex. scrypt встроен в node — никаких нативных сборок на сервере. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, KEY_LEN)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = (await scryptAsync(password, salt, KEY_LEN)) as Buffer;
  const expected = Buffer.from(hash, "hex");
  // Длины должны совпасть до timingSafeEqual, иначе он бросает исключение.
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Возвращает сырой токен для cookie; в базе лежит только его sha256. */
export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessionsTable).values({ tokenHash: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function findUserBySession(token: string): Promise<User | null> {
  const rows = await db
    .select({ user: usersTable, expiresAt: sessionsTable.expiresAt })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(usersTable.id, sessionsTable.userId))
    .where(eq(sessionsTable.tokenHash, hashToken(token)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await destroySession(token);
    return null;
  }
  return row.user;
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.tokenHash, hashToken(token)));
}

/** Чистка протухших сессий — вызывается при старте сервера. */
export async function purgeExpiredSessions(): Promise<void> {
  await db.delete(sessionsTable).where(lt(sessionsTable.expiresAt, new Date()));
}

/**
 * Счётчик «не больше limit событий на ключ за окно». В памяти процесса — этого
 * достаточно: пользователь один, а цель — сделать перебор бессмысленным, а не
 * строить распределённую защиту.
 *
 * Ключи приходят от анонимов (адреса, введённые почты), поэтому Map обязана
 * худеть: протухшие записи вычищаются по ходу дела, не чаще раза в окно, а на
 * случай наплыва уникальных ключей внутри одного окна есть потолок — сверх него
 * выкидываем самые старые записи (Map помнит порядок вставки).
 */
export function createRateLimiter(opts: { limit: number; windowMs: number; maxKeys?: number }) {
  const { limit, windowMs, maxKeys = 10_000 } = opts;
  const hits = new Map<string, { count: number; resetAt: number }>();
  let nextSweepAt = 0;

  function sweep(now: number): void {
    if (now >= nextSweepAt) {
      for (const [key, rec] of hits) if (now >= rec.resetAt) hits.delete(key);
      nextSweepAt = now + windowMs;
    }
    while (hits.size > maxKeys) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) break;
      hits.delete(oldest);
    }
  }

  /** Живая запись ключа или undefined, если её нет или окно истекло. */
  function live(key: string, now: number) {
    const rec = hits.get(key);
    if (rec && now >= rec.resetAt) {
      hits.delete(key);
      return undefined;
    }
    return rec;
  }

  return {
    /** Лимит на ключ уже исчерпан — дальше отказываем до конца окна. */
    blocked(key: string): boolean {
      const rec = live(key, Date.now());
      return rec !== undefined && rec.count >= limit;
    },
    /** Засчитать событие. Окно фиксированное: отсчёт от первого события. */
    hit(key: string): void {
      const now = Date.now();
      const rec = live(key, now);
      if (rec) rec.count += 1;
      else hits.set(key, { count: 1, resetAt: now + windowMs });
      sweep(now);
    },
    reset(key: string): void {
      hits.delete(key);
    },
    /** Для тестов: сколько ключей сейчас держим в памяти. */
    size(): number {
      return hits.size;
    },
  };
}

/** Восемь 16-битных групп IPv6-адреса: «::» раскрыт, IPv4-хвост переведён в две группы. */
function ipv6Groups(addr: string): number[] {
  let head = addr;
  const tail: number[] = [];
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    tail.push((a << 8) | b, (c << 8) | d);
    head = addr.slice(0, v4.index);
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((h) => parseInt(h, 16)));
  const gap = head.indexOf("::");
  if (gap === -1) return [...parse(head), ...tail];
  const left = parse(head.slice(0, gap));
  const right = [...parse(head.slice(gap + 2)), ...tail];
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * Ключ клиента для счётчиков попыток. Сырой IPv6-адрес ключом быть не может:
 * у любого абонента минимум /64, то есть 2^64 адресов, и сменой адреса
 * обходились бы и блокировка входа, и лимит сброса. Поэтому IPv6 сводим к
 * префиксу /64, а IPv4, пришедший в виде ::ffff:a.b.c.d, — к обычному IPv4,
 * чтобы один клиент не считался дважды. Нормализуем внутри функций ниже, а не
 * в маршрутах: новый вызывающий не сможет забыть это сделать.
 */
export function clientKey(ip: string | undefined): string {
  const addr = (ip ?? "").split("%")[0]!; // зона интерфейса (fe80::1%eth0) адрес не меняет
  if (isIPv4(addr)) return addr;
  // Не адрес вовсе — такого за nginx не бывает; складываем всё в одну корзину.
  if (!isIPv6(addr)) return "unknown";
  const g = ipv6Groups(addr);
  if (g.slice(0, 5).every((h) => h === 0) && g[5] === 0xffff) {
    return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join(".");
  }
  const prefix = g.slice(0, 4).map((h) => h.toString(16));
  return `${prefix.join(":")}::/64`;
}

// Неудачные входы по адресу клиента. Адрес настоящий только благодаря
// trust proxy в app.ts — без него за nginx у всех был бы 127.0.0.1 и один
// общий счётчик на весь интернет.
const LOGIN_MAX_ATTEMPTS = 10;
// Меняя окно, поправьте текст отказа TOO_MANY_ATTEMPTS_MESSAGE в routes/auth.ts.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = createRateLimiter({ limit: LOGIN_MAX_ATTEMPTS, windowMs: LOGIN_WINDOW_MS });

/** ip — как есть из req.ip, ключ считается внутри (см. clientKey). */
export function tooManyAttempts(ip: string | undefined): boolean {
  return loginFailures.blocked(clientKey(ip));
}

export function registerFailedAttempt(ip: string | undefined): void {
  loginFailures.hit(clientKey(ip));
}

export function clearAttempts(ip: string | undefined): void {
  loginFailures.reset(clientKey(ip));
}

// «Забыли пароль» считаем отдельно от неудачных входов: раньше десяток анонимных
// запросов сброса запирал вход самой владелице на 15 минут. Два счётчика: по
// адресу — против засыпания формы с одной машины, по почте — чтобы ящик не
// заваливали письмами сброса с разных адресов.
const FORGOT_WINDOW_MS = 60 * 60 * 1000;

/** Длиннее почтовых адресов не бывает (RFC 5321) — всё, что длиннее, заведомо не наш пользователь. */
export const MAX_EMAIL_LENGTH = 254;
const forgotByIp = createRateLimiter({ limit: 5, windowMs: FORGOT_WINDOW_MS });
const forgotByEmail = createRateLimiter({ limit: 3, windowMs: FORGOT_WINDOW_MS });

/**
 * Ключ счётчика почты — sha256, а не сама строка: введённую почту присылает
 * аноним, и сырой ключ был бы размером с тело запроса (до 5 МБ) и жил бы час.
 * Хэш фиксированной длины, и заодно чужие почты не лежат в памяти открытым текстом.
 */
function emailKey(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

/** Для тестов: сколько ключей держат счётчики «забыли пароль». */
export function forgotLimiterSizes(): { byIp: number; byEmail: number } {
  return { byIp: forgotByIp.size(), byEmail: forgotByEmail.size() };
}

/**
 * Можно ли обработать запрос сброса, и если да — засчитать его. Решение не
 * зависит от того, есть ли такая почта в базе: иначе отказ выдавал бы, кто
 * зарегистрирован. Запрос, отказанный по адресу, лимит почты не расходует:
 * уже заблокированный адрес не должен и дальше выжигать чужой ящик.
 */
export function allowForgotRequest(ip: string | undefined, email: string): boolean {
  const client = clientKey(ip);
  if (forgotByIp.blocked(client)) return false;
  forgotByIp.hit(client);
  // Заведомо ненастоящую почту считаем пустой: письма по ней не будет,
  // и занимать ею счётчик почты незачем — хватает лимита адреса.
  if (email === "" || email.length > MAX_EMAIL_LENGTH) return true;
  const key = emailKey(email);
  if (forgotByEmail.blocked(key)) return false;
  forgotByEmail.hit(key);
  return true;
}
