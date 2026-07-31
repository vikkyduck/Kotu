import { writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, documentsTable, transcriptionsTable, decksTable, type Transcription } from "@workspace/db";
import { LIBRARY_DIR } from "./paths";
import { maskText } from "./privacy";
import { enqueue } from "./jobs";
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
 * Кладёт готовую расшифровку в библиотеку — ТОЛЬКО в маскированном виде.
 *
 * Правило двух зон: библиотека — зона Б, её фрагменты уезжают за границу
 * (эмбеддинги, главы лекций). Расшифровка сеанса — зона А. Поэтому в файл
 * библиотеки и в индекс попадает текст с плейсхолдерами вместо имён; сама
 * расшифровка с настоящими именами остаётся на своём экране и никуда не едет.
 *
 * Идемпотентно: повторный вызов обновляет существующий документ и
 * переиндексирует его (правки автора в расшифровке доезжают до библиотеки).
 */
export async function syncTranscriptionDoc(t: Transcription): Promise<void> {
  const plain = t.segments
    .map((s) => (s.who ? `${s.who}: ${s.text}` : s.text))
    .join("\n\n")
    .trim();
  if (plain.length < 200) {
    // Правка могла ужать текст ниже порога — тогда и копия больше не нужна.
    await deleteTranscriptionDoc(t.id, t.ownerId);
    logger.info({ transcriptionId: t.id }, "Расшифровка коротка для библиотеки — пропускаю");
    return;
  }

  const { masked: rawMasked, degraded } = await maskText(plain);
  // Если текст УЖЕ содержал плейсхолдеры (маскировка на этапе расшифровки),
  // повторная маскировка оборачивает их второй парой скобок — схлопываем.
  const masked = rawMasked.replace(/\[{3,}((?:PER|LOC)\d+)\]{3,}/g, "[[$1]]");
  if (degraded) {
    // Эвристика перестраховывается, но не ловит имя в начале строки — а формат
    // «Имя: реплика» ставит его туда всегда. Без настоящего NER наружу нельзя:
    // отказываемся, стартовая сверка повторит, когда сервис вернётся.
    throw new Error("Сервис маскировки недоступен — расшифровку в библиотеку не отправляю");
  }

  // Расшифровку могли удалить, пока считалась маскировка, — не воскрешаем.
  const [alive] = await db
    .select({ id: transcriptionsTable.id })
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.id, t.id))
    .limit(1);
  if (!alive) return;

  const filePath = path.join(LIBRARY_DIR, `transcript-${t.id}.txt`);
  await writeFile(filePath, masked, "utf8");

  // Уникальный индекс по transcription_id превращает гонку двух sync в
  // спокойный «второй просто обновит».
  const inserted = await db
    .insert(documentsTable)
    .values({
      ownerId: t.ownerId,
      title: neutralTitle(t),
      kind: "transcript",
      transcriptionId: t.id,
      sourcePath: filePath,
      mime: "text/plain",
      status: "parsing",
      statusMessage: "В очереди…",
    })
    .onConflictDoNothing()
    .returning({ id: documentsTable.id });

  let docId = inserted[0]?.id;
  if (docId === undefined) {
    const [existing] = await db
      .select({ id: documentsTable.id })
      .from(documentsTable)
      .where(eq(documentsTable.transcriptionId, t.id))
      .limit(1);
    if (!existing) return;
    docId = existing.id;
    await db
      .update(documentsTable)
      .set({ title: neutralTitle(t), status: "parsing", statusMessage: "В очереди…", error: null })
      .where(eq(documentsTable.id, docId));
  }

  await enqueue("doc.ingest", docId, {
    sourcePath: filePath,
    mime: "text/plain",
    filename: `transcript-${t.id}.txt`,
  });
  logger.info({ transcriptionId: t.id, docId }, "Расшифровка отправлена в библиотеку");
}

/** Убирает расшифровку из библиотеки — все копии, с файлами и фрагментами. */
export async function deleteTranscriptionDoc(
  transcriptionId: number,
  ownerId: number,
): Promise<void> {
  const docs = await db
    .select()
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.transcriptionId, transcriptionId),
        eq(documentsTable.ownerId, ownerId),
      ),
    );

  for (const doc of docs) {
    await rm(doc.sourcePath, { force: true }).catch(() => undefined);
    // Фрагменты уйдут каскадом по FK documentId.
    await db.delete(documentsTable).where(eq(documentsTable.id, doc.id));
  }
}

/**
 * Стартовая сверка, в обе стороны:
 * — готовые расшифровки без библиотечной копии → создать (бэкфилл и
 *   самолечение после сбоев);
 * — transcript-документы, чья расшифровка исчезла → удалить (хвосты гонок
 *   удаления; уничтожение — без остатков, §10).
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
    logger.warn({ docId: doc.id }, "Библиотечная копия без расшифровки — удаляю");
    await rm(doc.sourcePath, { force: true }).catch(() => undefined);
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
