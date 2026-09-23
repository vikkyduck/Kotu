import { eq } from "drizzle-orm";
import { db, documentsTable, docChunksTable, type Job } from "@workspace/db";
import { extractText, chunkText } from "../documents";
import { embedAll } from "../embeddings";
import { registerHandler } from "../jobs";
import { logger } from "../logger";
import { MIN_LIBRARY_TEXT } from "../work-doc";

/**
 * Свойство самого файла: повтор его не изменит, поэтому это не сбой задачи,
 * а итог разбора — ошибка пишется сразу, без трёх попыток.
 */
export const NO_TEXT = "В файле почти нет текста. Если это скан, его нужно сначала распознать (OCR).";
export const NO_CHUNKS = "Не удалось разбить документ на фрагменты";
/** Лёг локальный сервис векторов: файл в порядке, повтор поможет. */
const SEARCH_DOWN = "Поиск не ответил — с файлом всё в порядке";
/** Всё остальное (pdfjs, JSZip, ENOENT) — сырое, оно в журнале. */
const UNREADABLE = "Не удалось прочитать файл";

export interface IngestPayload {
  sourcePath: string;
  mime: string;
  filename: string;
}

async function setStatus(id: number, message: string): Promise<void> {
  await db
    .update(documentsTable)
    .set({ status: "parsing", statusMessage: message })
    .where(eq(documentsTable.id, id));
}

async function markError(id: number, message: string): Promise<void> {
  await db
    .update(documentsTable)
    .set({ status: "error", statusMessage: "", error: message })
    .where(eq(documentsTable.id, id));
}

async function run(job: Job): Promise<void> {
  const payload = job.payload as unknown as IngestPayload;
  const id = job.entityId;

  // Документ могли удалить, пока задача стояла в очереди, — тогда просто
  // нечего делать, а не три попытки об исчезнувший файл.
  const [doc] = await db
    .select({ id: documentsTable.id })
    .from(documentsTable)
    .where(eq(documentsTable.id, id))
    .limit(1);
  if (!doc) {
    logger.info({ id }, "Документ удалён — разбор не нужен");
    return;
  }

  await setStatus(id, "Читаю файл…");
  const { text, pages } = await extractText(payload.sourcePath, payload.mime, payload.filename);

  // Обычно это скан без текстового слоя: картинки вместо букв.
  if (text.trim().length < MIN_LIBRARY_TEXT) return markError(id, NO_TEXT);

  await setStatus(id, "Делю на фрагменты…");
  const chunks = chunkText(text);
  if (chunks.length === 0) return markError(id, NO_CHUNKS);

  await setStatus(id, `Считаю векторы: 0 из ${chunks.length}…`);
  const vectors = await embedAll(
    chunks.map((c) => c.text),
    async (done, total) => {
      await setStatus(id, `Считаю векторы: ${done} из ${total}…`);
    },
  ).catch((err: unknown) => {
    logger.warn({ err, id }, "Векторы не посчитались");
    throw new Error(SEARCH_DOWN);
  });

  // При повторе задачи старые фрагменты убираем, чтобы не задвоить библиотеку.
  await db.delete(docChunksTable).where(eq(docChunksTable.documentId, id));
  await db.insert(docChunksTable).values(
    chunks.map((c, i) => ({
      documentId: id,
      ord: c.ord,
      heading: c.heading ?? null,
      page: c.page ?? null,
      text: c.text,
      embedding: vectors[i] ?? null,
    })),
  );

  await db
    .update(documentsTable)
    .set({
      status: "ready",
      statusMessage: "",
      error: null,
      chunkCount: chunks.length,
      pages: pages ?? null,
    })
    .where(eq(documentsTable.id, id));

  logger.info({ id, chunks: chunks.length, pages }, "Документ разобран");
}

async function onGiveUp(job: Job, message: string): Promise<void> {
  await markError(job.entityId, message === SEARCH_DOWN ? message : UNREADABLE).catch((err) =>
    logger.error({ err, id: job.entityId }, "Не смог записать ошибку документа"),
  );
}

export function registerIngestHandler(): void {
  registerHandler("doc.ingest", { run, onGiveUp });
}
