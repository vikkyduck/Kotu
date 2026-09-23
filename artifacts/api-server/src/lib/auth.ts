import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
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

// Неудачные входы по адресу клиента. Адрес настоящий только благодаря
// trust proxy в app.ts — без него за nginx у всех был бы 127.0.0.1 и один
// общий счётчик на весь интернет.
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = createRateLimiter({ limit: LOGIN_MAX_ATTEMPTS, windowMs: LOGIN_WINDOW_MS });

export function tooManyAttempts(ip: string): boolean {
  return loginFailures.blocked(ip);
}

export function registerFailedAttempt(ip: string): void {
  loginFailures.hit(ip);
}

export function clearAttempts(ip: string): void {
  loginFailures.reset(ip);
}

// «Забыли пароль» считаем отдельно от неудачных входов: раньше десяток анонимных
// запросов сброса запирал вход самой владелице на 15 минут. Два счётчика: по
// адресу — против засыпания формы с одной машины, по почте — чтобы ящик не
// заваливали письмами сброса с разных адресов.
const FORGOT_WINDOW_MS = 60 * 60 * 1000;
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
export function allowForgotRequest(ip: string, email: string): boolean {
  if (forgotByIp.blocked(ip)) return false;
  forgotByIp.hit(ip);
  if (email === "") return true;
  const key = emailKey(email);
  if (forgotByEmail.blocked(key)) return false;
  forgotByEmail.hit(key);
  return true;
}
