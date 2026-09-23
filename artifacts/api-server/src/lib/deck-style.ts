import { asc, eq } from "drizzle-orm";
import { db, stylePacksTable, type StylePack } from "@workspace/db";

/**
 * Стилевой пакет колоды: свой по id, а если его нет — первый доступный.
 * Одно правило для отрисовки, выгрузки и предпросмотра: иначе экран
 * показывал бы одни цвета, а PPTX выходил бы в других.
 */
export async function deckStylePack(stylePackId: number | null): Promise<StylePack | undefined> {
  if (stylePackId !== null) {
    const [own] = await db
      .select()
      .from(stylePacksTable)
      .where(eq(stylePacksTable.id, stylePackId))
      .limit(1);
    if (own) return own;
  }
  const [first] = await db.select().from(stylePacksTable).orderBy(asc(stylePacksTable.id)).limit(1);
  return first;
}
