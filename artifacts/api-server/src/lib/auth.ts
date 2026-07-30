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
 * Простой счётчик неудачных входов по IP. В памяти процесса — этого достаточно:
 * пользователь один, а цель — сделать перебор пароля бессмысленным, а не строить
 * распределённую защиту.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

export function tooManyAttempts(ip: string): boolean {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

export function registerFailedAttempt(ip: string): void {
  const rec = attempts.get(ip);
  if (!rec || Date.now() > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
    return;
  }
  rec.count += 1;
}

export function clearAttempts(ip: string): void {
  attempts.delete(ip);
}
