import { and, eq, isNotNull } from "drizzle-orm";
import { db, documentsTable, transcriptionsTable, type Transcription } from "@workspace/db";
import {
  dropCopies,
  dropOrphan,
  MIN_LIBRARY_TEXT,
  needsCopy,
  syncQuietly,
  upsertWorkDoc,
} from "./work-doc";
import { logger } from "./logger";
import { titleFrom } from "./title";

/**
 * Название копии в библиотеке - название самой записи (по нему её и ищут);
 * пустое - «Расшифровка от …». Одно правило и для разбора, и для
 * переименования записи (routes/transcriptions). Скрытия имён больше нет
 * (решение владелицы 18.11.2026), записей со скрытием на сервере не осталось.
 */
export function libraryTitle(t: Pick<Transcription, "title" | "createdAt">): string {
  const date = new Date(t.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  return titleFrom(t.title) || `Расшифровка от ${date}`;
}

/**
 * Кладёт готовую расшифровку в библиотеку.
 *
 * Фрагменты библиотеки уходят в модели (главы лекций) как есть: скрытия имён
 * больше нет (решение владелицы 18.11.2026).
 *
 * Идемпотентно: повторный вызов обновляет существующий документ и
 * переиндексирует его (правки автора в расшифровке доезжают до библиотеки).
 * Возвращает id копии или null, если копии нет (текст короткий, запись удалена).
 */
export async function syncTranscriptionDoc(t: Transcription): Promise<number | null> {
  const plain = t.segments
    .map((s) => (s.who ? `${s.who}: ${s.text}` : s.text))
    .join("\n\n")
    .trim();
  if (plain.length < MIN_LIBRARY_TEXT) {
    // Правка могла ужать текст ниже порога — тогда и копия больше не нужна.
    await deleteTranscriptionDoc(t.id, t.ownerId);
    logger.info({ transcriptionId: t.id }, "Расшифровка коротка для библиотеки — пропускаю");
    return null;
  }

  // Расшифровку могли удалить, пока шёл разбор, — не воскрешаем.
  const [alive] = await db
    .select({ id: transcriptionsTable.id })
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.id, t.id))
    .limit(1);
  if (!alive) return null;

  const docId = await upsertWorkDoc({
    ownerId: t.ownerId,
    title: libraryTitle(t),
    kind: "transcript",
    link: { column: documentsTable.transcriptionId, id: t.id },
    values: { transcriptionId: t.id },
    fileName: `transcript-${t.id}.txt`,
    text: plain,
  });
  if (docId !== null) logger.info({ transcriptionId: t.id, docId }, "Расшифровка отправлена в библиотеку");
  return docId;
}

/** Убирает расшифровку из библиотеки — все копии, с файлами и фрагментами. */
export const deleteTranscriptionDoc = (transcriptionId: number, ownerId: number) =>
  dropCopies(documentsTable.transcriptionId, transcriptionId, ownerId);

/**
 * Стартовая сверка, в обе стороны:
 * — готовые расшифровки без библиотечной копии или с копией в ошибке →
 *   собрать заново (бэкфилл и самолечение после сбоев);
 * — transcript-документы, чья расшифровка исчезла → убрать (хвосты гонок
 *   удаления). Строка и файл при этом остаются в архиве.
 */
export async function sweepTranscriptionsToLibrary(): Promise<number> {
  // Сначала уборка сирот — она же страхует гонку «PATCH-sync после DELETE».
  const transcriptDocs = await db
    .select({ id: documentsTable.id, transcriptionId: documentsTable.transcriptionId })
    .from(documentsTable)
    .where(and(eq(documentsTable.kind, "transcript"), isNotNull(documentsTable.transcriptionId)));
  for (const doc of transcriptDocs) {
    const [alive] = await db
      .select({ id: transcriptionsTable.id })
      .from(transcriptionsTable)
      .where(eq(transcriptionsTable.id, doc.transcriptionId!))
      .limit(1);
    if (!alive) await dropOrphan(documentsTable.transcriptionId, doc.transcriptionId!, doc.id);
  }

  const rows = await db
    .select()
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.status, "done"));
  let synced = 0;
  for (const t of rows) {
    if (!(await needsCopy(documentsTable.transcriptionId, t.id))) continue;
    if (await syncQuietly(syncTranscriptionDoc(t), "transcription", t.id)) synced += 1;
  }
  return synced;
}
