import { and, eq } from "drizzle-orm";
import { db, foldersTable } from "@workspace/db";

/**
 * Проверка папки перед перекладыванием. Папки держат не только книги, но и
 * лекции с презентациями — правило «чужая папка не годится» одно на всех,
 * поэтому живёт в одном месте.
 *
 * null — «вынуть из папки», число — папка автора, undefined — папки нет
 * (или она чужая): вызывающий отвечает 404.
 */
export async function ownFolderId(
  raw: unknown,
  ownerId: number,
): Promise<number | null | undefined> {
  if (raw === null) return null;
  const id = Number(raw);
  if (!Number.isInteger(id)) return undefined;
  const [folder] = await db
    .select({ id: foldersTable.id })
    .from(foldersTable)
    .where(and(eq(foldersTable.id, id), eq(foldersTable.ownerId, ownerId)))
    .limit(1);
  return folder?.id;
}
