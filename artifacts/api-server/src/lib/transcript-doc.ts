import { and, eq, isNotNull } from "drizzle-orm";
import { db, documentsTable, transcriptionsTable, type Transcription } from "@workspace/db";
import { archiveAndRemove } from "./archive";
import { maskText, NerUnavailableError } from "./privacy";
import { dropCopies, MIN_LIBRARY_TEXT, upsertWorkDoc } from "./work-doc";
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
 */
export async function syncTranscriptionDoc(t: Transcription): Promise<void> {
  const plain = t.segments
    .map((s) => (s.who ? `${s.who}: ${s.text}` : s.text))
    .join("\n\n")
    .trim();
  if (plain.length < MIN_LIBRARY_TEXT) {
    // Правка могла ужать текст ниже порога — тогда и копия больше не нужна.
    // Проверка до маскировки: короткий текст незачем гонять через NER.
    await deleteTranscriptionDoc(t.id, t.ownerId);
    logger.info({ transcriptionId: t.id }, "Расшифровка коротка для библиотеки — пропускаю");
    return;
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
  if (!alive) return;

  const docId = await upsertWorkDoc({
    ownerId: t.ownerId,
    title,
    kind: "transcript",
    link: { column: documentsTable.transcriptionId, id: t.id },
    values: { transcriptionId: t.id },
    folderId: null,
    fileName: `transcript-${t.id}.txt`,
    text,
  });
  if (docId === null) return;
  logger.info({ transcriptionId: t.id, docId }, "Расшифровка отправлена в библиотеку");
}

/** Убирает расшифровку из библиотеки — все копии, с файлами и фрагментами. */
export const deleteTranscriptionDoc = (transcriptionId: number, ownerId: number) =>
  dropCopies(documentsTable.transcriptionId, transcriptionId, ownerId);

/**
 * Стартовая сверка, в обе стороны:
 * — готовые расшифровки без библиотечной копии → создать (бэкфилл и
 *   самолечение после сбоев);
 * — transcript-документы, чья расшифровка исчезла → убрать (хвосты гонок
 *   удаления). Строка и файл при этом остаются в архиве.
 */
export async function sweepTranscriptionsToLibrary(): Promise<number> {
  // Сначала уборка сирот — она же страхует гонку «PATCH-sync после DELETE».
  const transcriptDocs = await db
    .select()
    .from(documentsTable)
    .where(and(eq(documentsTable.kind, "transcript"), isNotNull(documentsTable.transcriptionId)));
  for (const doc of transcriptDocs) {
    const [alive] = await db
      .select({ id: transcriptionsTable.id })
      .from(transcriptionsTable)
      .where(eq(transcriptionsTable.id, doc.transcriptionId!))
      .limit(1);
    if (alive) continue;
    logger.warn({ docId: doc.id }, "Библиотечная копия без расшифровки — убираю в архив");
    try {
      await archiveAndRemove(doc.sourcePath, {
        entityType: "document",
        entityId: doc.id,
        mime: doc.mime,
      });
    } catch (err) {
      logger.error({ err, docId: doc.id }, "Копия не заархивировалась — оставил как есть");
      continue;
    }
    await db.delete(documentsTable).where(eq(documentsTable.id, doc.id));
  }

  const rows = await db
    .select()
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.status, "done"));
  let synced = 0;
  for (const t of rows) {
    const [doc] = await db
      .select({ id: documentsTable.id })
      .from(documentsTable)
      .where(eq(documentsTable.transcriptionId, t.id))
      .limit(1);
    if (doc) continue;
    try {
      await syncTranscriptionDoc(t);
      synced += 1;
    } catch (err) {
      logger.error({ err, transcriptionId: t.id }, "Не смог отправить расшифровку в библиотеку");
    }
  }
  return synced;
}
