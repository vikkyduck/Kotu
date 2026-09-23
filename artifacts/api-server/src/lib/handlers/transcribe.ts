import { eq } from "drizzle-orm";
import { db, transcriptionsTable, type Job } from "@workspace/db";
import { transcribeLongAudio, ChunkError } from "../transcription";
import { registerHandler } from "../jobs";
import { syncTranscriptionDoc } from "../transcript-doc";
import { logger } from "../logger";
import { UPLOAD_DIR } from "../paths";
import { resolveInsideDir } from "../uploads";
import { archiveAndRemove } from "../archive";

export interface TranscribePayload {
  inputPath: string;
  filename: string;
  hideNames: boolean;
  markSpeakers: boolean;
}

/**
 * Запись удалили, пока шла расшифровка. Проверка — перед каждым куском (через
 * обновление прогресса): дальше платить модели и держать однопоточную очередь
 * незачем. Аудио уже в архиве — это сделал DELETE.
 */
class RecordGone extends Error {}

async function run(job: Job): Promise<void> {
  const payload = job.payload as unknown as TranscribePayload;
  const id = job.entityId;

  // Рестарт мог оборвать задачу ПОСЛЕ готовности (на шаге отправки в
  // библиотеку): повторная расшифровка переписала бы готовый текст, может
  // быть уже поправленный руками. Готовую запись не трогаем — только
  // досылаем в библиотеку.
  const [existing] = await db
    .select()
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.id, id))
    .limit(1);
  // Запись удалили, пока задача ждала очереди (или повтора): расшифровывать
  // некому. Аудио убираем из загрузок (в архиве оно остаётся) и выходим
  // тихо: ошибка здесь только сожгла бы попытки.
  if (!existing) {
    await removeAudio(payload, id);
    logger.info({ id }, "Запись удалена до расшифровки — аудио убрал в архив");
    return;
  }
  if (existing.status === "done") {
    await syncTranscriptionDoc(existing).catch((err) =>
      logger.error({ err, id }, "Расшифровка не доехала до библиотеки"),
    );
    return;
  }

  // При повторе запись могла остаться в состоянии ошибки — возвращаем в работу.
  // Пустой ответ — запись удалили между проверкой выше и этим шагом.
  const started = await db
    .update(transcriptionsTable)
    .set({ status: "processing", progress: 4, statusMessage: "Готовлю запись…", error: null })
    .where(eq(transcriptionsTable.id, id))
    .returning({ id: transcriptionsTable.id });
  if (started.length === 0) {
    logger.info({ id }, "Запись удалена до расшифровки — не начинаю");
    return;
  }

  try {
    const segments = await transcribeLongAudio(
      payload.inputPath,
      payload.filename,
      { hideNames: payload.hideNames, markSpeakers: payload.markSpeakers },
      async ({ progress, message }) => {
        const alive = await db
          .update(transcriptionsTable)
          .set({ progress, statusMessage: message })
          .where(eq(transcriptionsTable.id, id))
          .returning({ id: transcriptionsTable.id });
        if (alive.length === 0) throw new RecordGone();
      },
    );

    await db
      .update(transcriptionsTable)
      .set({ segments, status: "done", progress: 100, statusMessage: "", error: null })
      .where(eq(transcriptionsTable.id, id));

    logger.info({ id, segments: segments.length }, "Расшифровка готова");
    // Аудио после успеха НЕ удаляем: решение владелицы 23.09.2026 — всё
    // загруженное хранится, пока она сама не удалит запись. Это осознанно
    // отменяет прежнюю минимизацию по 152-ФЗ (ARCHITECTURE.md §10).

    // Готовая расшифровка едет в библиотеку (со скрытием имён — маскированной). Сбой здесь
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
    // Удаление — не сбой: задача закрывается тихо, без повтора и без записи
    // «пробую ещё раз» в строку, которой уже нет.
    if (err instanceof RecordGone) {
      logger.info({ id }, "Запись удалена во время расшифровки — остановился");
      return;
    }
    // Понятная человеку формулировка попадёт в last_error и дальше — в карточку
    // записи, если попытки закончатся.
    const message = err instanceof ChunkError ? err.userMessage : "Не удалось распознать запись";
    logger.error({ err, id }, "Расшифровка сорвалась");
    // До повтора очередь ждёт до двух минут — полоса не должна молча стоять.
    // Попытки кончились — onGiveUp тут же перепишет строку в ошибку.
    await db
      .update(transcriptionsTable)
      .set({ statusMessage: "Не получилось, пробую ещё раз…" })
      .where(eq(transcriptionsTable.id, id))
      .catch((e) => logger.error({ err: e, id }, "Не смог записать статус повтора"));
    throw new Error(message);
  }
}

async function onGiveUp(job: Job, message: string): Promise<void> {
  // Аудио НЕ удаляем: попытки сжигает не только плохой файл, но и деплой
  // посреди задачи, сбой транзита, недоступный NER. Запись остаётся на диске,
  // чтобы «Попробовать ещё раз» повторило её без повторной загрузки. Лежит,
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
  // Исключение — записи больше нет: повторять нечего, аудио убираем.
  if (updated && updated.length === 0) {
    await removeAudio(job.payload as unknown as TranscribePayload, job.entityId);
  }
}

/**
 * Аудио записи, которой больше нет, — из загрузок в архив. Путь из базы —
 * только внутри загрузок. Не заархивировалось — файл остаётся на месте.
 */
async function removeAudio(payload: TranscribePayload, id: number): Promise<void> {
  const audio = resolveInsideDir(UPLOAD_DIR, payload.inputPath);
  if (!audio) return;
  await archiveAndRemove(audio, {
    entityType: "transcription",
    entityId: id,
    originalName: payload.filename,
  }).catch((err) => logger.error({ err, id }, "Аудио не заархивировалось — оставил на месте"));
}

export function registerTranscribeHandler(): void {
  registerHandler("transcribe", { run, onGiveUp });
}
