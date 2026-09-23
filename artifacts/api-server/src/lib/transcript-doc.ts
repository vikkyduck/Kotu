import { and, eq, isNotNull } from "drizzle-orm";
import { db, documentsTable, transcriptionsTable, type Transcription } from "@workspace/db";
import { maskText, NerUnavailableError } from "./privacy";
import {
  dropCopies,
  dropOrphan,
  MIN_LIBRARY_TEXT,
  needsCopy,
  syncQuietly,
  upsertWorkDoc,
} from "./work-doc";
import { logger } from "./logger";

/**
 * Название библиотечной копии — нейтральное, БЕЗ названия записи. Записи автор
 * называет сам («Анна, сеанс 12») — такое имя из зоны А нельзя пускать в зону Б:
 * documents.title уходит в поисковые цитаты лекций и в промпты зарубежных
 * моделей. Настоящее название живёт только на экране расшифровки.
 */
function neutralTitle(t: Transcription): string {
  const d = new Date(t.createdAt);
  return `Расшифровка от ${d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}`;
}

/**
 * Текст и название библиотечной копии. Со скрытием имён — маскировка (NER
 * недоступен → исключение, копия не пишется) и нейтральное название. Без
 * скрытия (лекции, воркшопы) — текст как есть и настоящее название записи:
 * по нему копию и ищут в библиотеке. Отдельно от записи в базу — ради тестов.
 */
export async function prepareLibraryCopy(
  t: Transcription,
  plain: string,
): Promise<{ text: string; title: string }> {
  if (!t.hideNames) {
    // Ограничения — как у PATCH /documents: название в библиотеке до 200 знаков.
    return { text: plain, title: t.title.trim().slice(0, 200) || neutralTitle(t) };
  }
  const { masked: rawMasked } = await maskText(plain).catch((err: unknown) => {
    // Без настоящего NER наружу нельзя: отказываемся, стартовая сверка
    // повторит, когда сервис вернётся.
    if (err instanceof NerUnavailableError) {
      throw new Error("Сервис маскировки недоступен — расшифровку в библиотеку не отправляю", {
        cause: err,
      });
    }
    throw err;
  });
  // Если текст УЖЕ содержал плейсхолдеры (маскировка на этапе расшифровки),
  // повторная маскировка оборачивает их второй парой скобок — схлопываем.
  const masked = rawMasked.replace(/\[{3,}((?:PER|LOC)\d+)\]{3,}/g, "[[$1]]");
  return { text: masked, title: neutralTitle(t) };
}

/**
 * Кладёт готовую расшифровку в библиотеку.
 *
 * Фрагменты библиотеки уходят в модели (главы лекций). Поэтому, если при
 * расшифровке попросили скрыть имена, в файл и в индекс попадает текст с
 * плейсхолдерами вместо имён; без скрытия (лекции, воркшопы — решение
 * владелицы 23.09.2026) — текст как есть.
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
    // Проверка до маскировки: короткий текст незачем гонять через NER.
    await deleteTranscriptionDoc(t.id, t.ownerId);
    logger.info({ transcriptionId: t.id }, "Расшифровка коротка для библиотеки — пропускаю");
    return null;
  }

  // Имена скрывали при расшифровке — скрываем и в библиотечной копии: по ней
  // собираются лекции, а это отправка в модель.
  const { text, title } = await prepareLibraryCopy(t, plain);

  // Расшифровку могли удалить, пока считалась маскировка, — не воскрешаем.
  const [alive] = await db
    .select({ id: transcriptionsTable.id })
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.id, t.id))
    .limit(1);
  if (!alive) return null;

  const docId = await upsertWorkDoc({
    ownerId: t.ownerId,
    title,
    kind: "transcript",
    link: { column: documentsTable.transcriptionId, id: t.id },
    values: { transcriptionId: t.id },
    fileName: `transcript-${t.id}.txt`,
    text,
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
