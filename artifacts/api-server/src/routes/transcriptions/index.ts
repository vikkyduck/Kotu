import { Router, type IRouter } from "express";
import multer from "multer";
import { eq, desc } from "drizzle-orm";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { db, transcriptionsTable, type TranscriptSegment } from "@workspace/db";
import {
  GetTranscriptionParams,
  GetTranscriptionResponse,
  UpdateTranscriptionParams,
  UpdateTranscriptionBody,
  UpdateTranscriptionResponse,
  DeleteTranscriptionParams,
  ListTranscriptionsResponse,
} from "@workspace/api-zod";
import { transcribeLongAudio, ChunkError } from "../../lib/transcription";
import { logger } from "../../lib/logger";

// Long recordings (2–3 hours) are split server-side, so allow large uploads.
// Files are streamed to disk (not held in memory) and split with ffmpeg.
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

// Anything ffmpeg can decode is fine (it is re-encoded to mp3 before
// transcription), so accept a broad set of audio and video containers.
const ALLOWED_EXT =
  /\.(mp3|mp2|m4a|m4b|mp4|mov|wav|wave|aif|aiff|aac|ogg|oga|opus|webm|mkv|flac|amr|3gp|3gpp|wma|caf|mka|mpeg|mpga)$/i;

const upload = multer({
  dest: tmpdir(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    // Audio can also live inside video containers (e.g. audio-only webm reports
    // "video/webm"), so accept any audio/* or video/* type, and fall back to a
    // recognised file extension for browsers that send a vague mimetype.
    const type = file.mimetype.toLowerCase();
    const looksLikeMedia = type.startsWith("audio/") || type.startsWith("video/");
    if (looksLikeMedia || ALLOWED_EXT.test(file.originalname)) {
      cb(null, true);
      return;
    }
    cb(new Error("UNSUPPORTED_FILE_TYPE"));
  },
});

const router: IRouter = Router();

router.get("/transcriptions", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(transcriptionsTable)
    .orderBy(desc(transcriptionsTable.createdAt));
  res.json(ListTranscriptionsResponse.parse(rows));
});

router.get("/transcriptions/:id", async (req, res): Promise<void> => {
  const params = GetTranscriptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db
    .select()
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.id, params.data.id));

  if (!row) {
    res.status(404).json({ error: "Расшифровка не найдена" });
    return;
  }

  res.json(GetTranscriptionResponse.parse(row));
});

router.patch("/transcriptions/:id", async (req, res): Promise<void> => {
  const params = UpdateTranscriptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateTranscriptionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<typeof transcriptionsTable.$inferInsert> = {};
  if (parsed.data.title != null) updates.title = parsed.data.title;
  if (parsed.data.segments != null) {
    updates.segments = parsed.data.segments as TranscriptSegment[];
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Нет данных для обновления" });
    return;
  }

  const [row] = await db
    .update(transcriptionsTable)
    .set(updates)
    .where(eq(transcriptionsTable.id, params.data.id))
    .returning();

  if (!row) {
    res.status(404).json({ error: "Расшифровка не найдена" });
    return;
  }

  res.json(UpdateTranscriptionResponse.parse(row));
});

router.delete("/transcriptions/:id", async (req, res): Promise<void> => {
  const params = DeleteTranscriptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db
    .delete(transcriptionsTable)
    .where(eq(transcriptionsTable.id, params.data.id))
    .returning();

  if (!row) {
    res.status(404).json({ error: "Расшифровка не найдена" });
    return;
  }

  res.sendStatus(204);
});

/**
 * Process an uploaded recording in the background: split into chunks, transcribe,
 * stitch, and persist progress on the row so the client can poll it. The uploaded
 * temp file is always cleaned up at the end.
 */
async function processTranscription(
  id: number,
  inputPath: string,
  filename: string,
  opts: { hideNames: boolean; markSpeakers: boolean },
): Promise<void> {
  try {
    const segments = await transcribeLongAudio(
      inputPath,
      filename,
      opts,
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

    logger.info({ id, segments: segments.length }, "Transcription finished");
  } catch (err) {
    const userMessage =
      err instanceof ChunkError
        ? err.userMessage
        : "Не удалось распознать запись. Попробуйте другой файл.";
    logger.error({ err, id }, "Transcription failed");
    await db
      .update(transcriptionsTable)
      .set({ status: "error", statusMessage: "", error: userMessage })
      .where(eq(transcriptionsTable.id, id))
      .catch((dbErr) => logger.error({ dbErr, id }, "Failed to persist error state"));
  } finally {
    await rm(inputPath, { force: true }).catch(() => {});
  }
}

router.post(
  "/transcriptions/upload",
  (req, res, next) => {
    upload.single("audio")(req, res, (err: unknown) => {
      if (err) {
        const code = (err as { code?: string }).code;
        if (code === "LIMIT_FILE_SIZE") {
          res
            .status(413)
            .json({ error: "Файл слишком большой. Максимальный размер — 1 ГБ." });
          return;
        }
        if (err instanceof Error && err.message === "UNSUPPORTED_FILE_TYPE") {
          res
            .status(415)
            .json({ error: "Это не похоже на аудиозапись. Загрузите аудиофайл." });
          return;
        }
        req.log.warn({ err }, "Upload failed");
        res.status(400).json({ error: "Не удалось загрузить файл" });
        return;
      }
      next();
    });
  },
  async (req, res): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "Не приложен аудиофайл" });
      return;
    }

    const hideNames = req.body?.hideNames === "true";
    const markSpeakers = req.body?.markSpeakers === "true";
    const filename = req.file.originalname || "запись";
    const inputPath = req.file.path;
    const title = filename.replace(/\.[^.]+$/, "") || "Запись";

    req.log.info({ filename, hideNames, markSpeakers }, "Queued transcription");

    const [row] = await db
      .insert(transcriptionsTable)
      .values({
        title,
        filename,
        hideNames,
        markSpeakers,
        segments: [] as TranscriptSegment[],
        status: "processing",
        progress: 4,
        statusMessage: "Готовлю запись…",
      })
      .returning();

    // Kick off processing without blocking the response — long recordings can take
    // several minutes, far longer than a single request should stay open.
    void processTranscription(row.id, inputPath, filename, { hideNames, markSpeakers });

    res.status(201).json(GetTranscriptionResponse.parse(row));
  },
);

export default router;
