import { and, eq } from "drizzle-orm";
import { db, foldersTable } from "@workspace/db";
import { parseId } from "./parse-id";

/**
 * Проверка папки перед перекладыванием. Папки держат не только книги, но и
 * лекции с презентациями — правило «чужая папка не годится» одно на всех,
 * поэтому живёт в одном месте.
 *
 * null — «вынуть из папки», число — папка автора, undefined — папки нет
 * (или она чужая): вызывающий отвечает 404.
 *
 * Номер приходит числом из JSON (перекладывание) или строкой из формы
 * (загрузка прямо в папку) — разбираем одним правилом с номерами в адресе:
 * «0x10», «1e1» и true папкой не считаются.
 */
export async function ownFolderId(
  raw: unknown,
  ownerId: number,
): Promise<number | null | undefined> {
  if (raw === null) return null;
  const id = parseId(typeof raw === "number" ? String(raw) : raw);
  if (id === null) return undefined;
  const [folder] = await db
    .select({ id: foldersTable.id })
    .from(foldersTable)
    .where(and(eq(foldersTable.id, id), eq(foldersTable.ownerId, ownerId)))
    .limit(1);
  return folder?.id;
}
