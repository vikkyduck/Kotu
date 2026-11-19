import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "@workspace/db";
import { parseId } from "./parse-id";

/** Таблица работ владельца: у строки есть id и ownerId. */
type OwnedTable = PgTable & { id: PgColumn; ownerId: PgColumn };

/**
 * Строка строго своего владельца по id из адреса. Кривой id - как чужая
 * строка: null. Одна проверка на лекции, презентации, документы и записи:
 * чужое не открывается ни одной ручкой.
 */
export async function ownedRow<T extends OwnedTable>(
  table: T,
  rawId: unknown,
  ownerId: number,
): Promise<T["$inferSelect"] | null> {
  const id = parseId(rawId);
  if (id === null) return null;
  const [row] = await db
    .select()
    .from(table as PgTable)
    .where(and(eq(table.id, id), eq(table.ownerId, ownerId)))
    .limit(1);
  return (row as T["$inferSelect"] | undefined) ?? null;
}

/** То же для ручки: своей строки нет - 404 с понятной фразой и null (ручке остаётся выйти). */
export async function ownedOr404<T extends OwnedTable>(
  table: T,
  req: Request,
  res: Response,
  message: string,
): Promise<T["$inferSelect"] | null> {
  const row = await ownedRow(table, req.params["id"], req.user!.id);
  if (!row) res.status(404).json({ message });
  return row;
}
