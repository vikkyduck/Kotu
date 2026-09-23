import { rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, transcriptionsTable, type Job } from "@workspace/db";
import { transcribeLongAudio, ChunkError } from "../transcription";
import { registerHandler } from "../jobs";
import { syncTranscriptionDoc } from "../transcript-doc";
import { logger } from "../logger";
import { UPLOAD_DIR } from "../paths";
import { resolveInsideDir } from "../uploads";

export interface TranscribePayload {
  inputPath: string;
  filename: string;
  hideNames: boolean;
  markSpeakers: boolean;
}

async function run(job: Job): Promise<void> {
  const payload = job.payload as unknown as TranscribePayload;
  const id = job.entityId;

  // Рестарт мог оборвать задачу ПОСЛЕ готовности (на шаге отправки в
  // библиотеку): повторная расшифровка сожгла бы готовый текст об удалённое
  // аудио. Готовую запись не трогаем — только досылаем в библиотеку.
  const [existing] = await db
    .select()
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.id, id))
    .limit(1);
  // Запись удалили, пока задача ждала очереди (или повтора): расшифровывать
  // некому, а аудио сеанса без записи — ничьё. Убираем его и выходим тихо:
  // ошибка здесь только сожгла бы попытки и оставила файл на диске.
  if (!existing) {
    await removeAudio(payload);
    logger.info({ id }, "Запись удалена до расшифровки — убрал аудио");
    return;
  }
  if (existing.status === "done") {
    await syncTranscriptionDoc(existing).catch((err) =>
      logger.error({ err, id }, "Расшифровка не доехала до библиотеки"),
    );
    return;
  }

  // При повторе запись могла остаться в состоянии ошибки — возвращаем в работу.
  await db
    .update(transcriptionsTable)
    .set({ status: "processing", progress: 4, statusMessage: "Готовлю запись…", error: null })
    .where(eq(transcriptionsTable.id, id));

  try {
    const segments = await transcribeLongAudio(
      payload.inputPath,
      payload.filename,
      { hideNames: payload.hideNames, markSpeakers: payload.markSpeakers },
      async ({ progress, message }) => {
        await db
          .update(transcriptionsTable)
          .set({ progress, statusMessage: message })
          .where(eq(transcriptionsTable.id, id));
      },
    );

    await db
      .update(transcriptionsTable)
      .set({ segments, status: "done", progress: 100, statusMessage: "", error: null })
      .where(eq(transcriptionsTable.id, id));

    logger.info({ id, segments: segments.length }, "Расшифровка готова");
    // Аудио больше не нужно: дальше живёт только текст.
    await rm(payload.inputPath, { force: true }).catch(() => {});

    // Готовая расшифровка едет в библиотеку (в маскированном виде). Сбой здесь
    // не должен ронять готовую расшифровку — стартовая сверка догонит.
    const [fresh] = await db
      .select()
      .from(transcriptionsTable)
      .where(eq(transcriptionsTable.id, id))
      .limit(1);
    if (fresh) {
      await syncTranscriptionDoc(fresh).catch((err) =>
        logger.error({ err, id }, "Расшифровка не доехала до библиотеки"),
      );
    }
  } catch (err) {
    // Понятная человеку формулировка попадёт в last_error и дальше — в карточку
    // записи, если попытки закончатся.
    const message =
      err instanceof ChunkError
        ? err.userMessage
        : "Не удалось распознать запись. Попробуйте другой файл.";
    logger.error({ err, id }, "Расшифровка сорвалась");
    throw new Error(message);
  }
}

async function onGiveUp(job: Job, message: string): Promise<void> {
  // Аудио НЕ удаляем: попытки сжигает не только плохой файл, но и деплой
  // посреди задачи, сбой транзита, недоступный NER. Запись остаётся на диске,
  // чтобы «Попробовать снова» повторило её без повторной загрузки. Лежит,
  // пока владелица не повторит или не удалит запись (см. lib/uploads.ts).
  const updated = await db
    .update(transcriptionsTable)
    .set({ status: "error", statusMessage: "", error: message })
    .where(eq(transcriptionsTable.id, job.entityId))
    .returning({ id: transcriptionsTable.id })
    .catch((err) => {
      logger.error({ err, id: job.entityId }, "Не смог записать состояние ошибки");
      return null;
    });
  // Исключение — записи больше нет: повторять нечего, аудио ничьё.
  if (updated && updated.length === 0) {
    await removeAudio(job.payload as unknown as TranscribePayload);
  }
}

/** Аудио записи, которой больше нет. Путь из базы — только внутри загрузок. */
async function removeAudio(payload: TranscribePayload): Promise<void> {
  const audio = resolveInsideDir(UPLOAD_DIR, payload.inputPath);
  if (audio) await rm(audio, { force: true }).catch(() => {});
}

export function registerTranscribeHandler(): void {
  registerHandler("transcribe", { run, onGiveUp });
}
