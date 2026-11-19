import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db, decksTable, documentsTable, lecturesTable } from "@workspace/db";

/**
 * Связи между работами: из чего сделано и что уже сделано из этого.
 *
 * Материал «гуляет» по инструментам: расшифровка становится лекцией, лекция -
 * презентацией. Экраны показывают эти связи ссылками, чтобы автор видел
 * готовое и не собирал ту же презентацию второй раз. Одно место на все экраны
 * (лекция, презентация, запись) - правила связи не расходятся.
 */

/** Работа одной строкой: куда вести ссылку и как её подписать. */
export interface WorkRef {
  id: number;
  title: string;
}

/** Материал библиотеки: книга открывается файлом, копия записи - экраном записи. */
export interface MaterialRef extends WorkRef {
  kind: string;
  transcriptionId: number | null;
}

/** Что уже сделано из материала. */
export interface MadeFrom {
  lectures: WorkRef[];
  decks: WorkRef[];
}

/** Из чего собрана презентация. */
export type DeckSource = ({ type: "lecture" } & WorkRef) | ({ type: "document" } & MaterialRef);

/** Материалы по id - только свои, в порядке, в каком их выбрал автор. */
export async function materialsByIds(ownerId: number, ids: readonly number[]): Promise<MaterialRef[]> {
  const wanted = ids.filter((id) => Number.isInteger(id) && id > 0);
  if (wanted.length === 0) return [];
  const rows = await db
    .select({
      id: documentsTable.id,
      title: documentsTable.title,
      kind: documentsTable.kind,
      transcriptionId: documentsTable.transcriptionId,
    })
    .from(documentsTable)
    .where(and(eq(documentsTable.ownerId, ownerId), inArray(documentsTable.id, wanted)));
  return wanted.flatMap((id) => rows.filter((r) => r.id === id));
}

/** Условие «этот документ в опоре лекции» (brief.documentIds) - значение параметром. */
export function briefHasDocument(documentId: number): SQL {
  return sql`${lecturesTable.brief} -> 'documentIds' @> ${JSON.stringify([documentId])}::jsonb`;
}

/** Что сделано из лекции или из документа библиотеки - свежее сверху. */
export async function madeFrom(
  ownerId: number,
  from: { lectureId: number } | { documentId: number },
): Promise<MadeFrom> {
  const [sourceKind, sourceId] =
    "lectureId" in from ? (["lecture", from.lectureId] as const) : (["document", from.documentId] as const);

  const decks = await db
    .select({ id: decksTable.id, title: decksTable.title })
    .from(decksTable)
    .where(
      and(eq(decksTable.ownerId, ownerId), eq(decksTable.sourceKind, sourceKind), eq(decksTable.sourceId, sourceId)),
    )
    .orderBy(desc(decksTable.createdAt));

  // Лекцию пишут по документам библиотеки; у самой лекции в опоре только они.
  const lectures =
    "documentId" in from
      ? await db
          .select({ id: lecturesTable.id, title: lecturesTable.title })
          .from(lecturesTable)
          .where(and(eq(lecturesTable.ownerId, ownerId), briefHasDocument(from.documentId)))
          .orderBy(desc(lecturesTable.createdAt))
      : [];

  return { lectures, decks };
}

/** Из чего собрана презентация; вставленный текст или удалённый источник - null. */
export async function deckSource(
  ownerId: number,
  deck: { sourceKind: string; sourceId: number | null },
): Promise<DeckSource | null> {
  if (deck.sourceId === null) return null;
  if (deck.sourceKind === "lecture") {
    const [row] = await db
      .select({ id: lecturesTable.id, title: lecturesTable.title })
      .from(lecturesTable)
      .where(and(eq(lecturesTable.id, deck.sourceId), eq(lecturesTable.ownerId, ownerId)))
      .limit(1);
    return row ? { type: "lecture", ...row } : null;
  }
  if (deck.sourceKind === "document") {
    const [doc] = await materialsByIds(ownerId, [deck.sourceId]);
    return doc ? { type: "document", ...doc } : null;
  }
  return null;
}
