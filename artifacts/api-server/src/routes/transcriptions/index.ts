import { tmpdir } from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { Router, type IRouter } from "express";
import multer from "multer";
import { eq, desc } from "drizzle-orm";
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
import { transcribeRecording } from "../../lib/transcription";

// Long recordings are split server-side, so the practical limit is generous.
const MAX_FILE_BYTES = 300 * 1024 * 1024;
const MAX_FILE_MB = Math.round(MAX_FILE_BYTES / (1024 * 1024));

const ALLOWED_EXT = /\.(mp3|m4a|wav|mp4|ogg|oga|webm|flac|aac|mpeg|mpga)$/i;

const upload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || "";
      cb(null, `kot-upload-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const isAudio = file.mimetype.startsWith("audio/") || file.mimetype === "video/mp4";
    if (isAudio || ALLOWED_EXT.test(file.originalname)) {
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

router.post(
  "/transcriptions/upload",
  (req, res, next) => {
    upload.single("audio")(req, res, (err: unknown) => {
      if (err) {
        const code = (err as { code?: string }).code;
        if (code === "LIMIT_FILE_SIZE") {
          res
            .status(413)
            .json({ error: `Файл слишком большой. Максимальный размер — ${MAX_FILE_MB} МБ.` });
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

    req.log.info({ filename, hideNames, markSpeakers }, "Transcribing audio");

    let segments: TranscriptSegment[];
    try {
      segments = await transcribeRecording(inputPath, { hideNames, markSpeakers });
    } catch (err) {
      req.log.error({ err }, "Transcription failed");
      res
        .status(502)
        .json({ error: "Не удалось распознать запись. Попробуйте другой файл." });
      return;
    } finally {
      await rm(inputPath, { force: true }).catch(() => {});
    }

    const title = filename.replace(/\.[^.]+$/, "") || "Запись";

    const [row] = await db
      .insert(transcriptionsTable)
      .values({ title, filename, hideNames, markSpeakers, segments })
      .returning();

    res.status(201).json(GetTranscriptionResponse.parse(row));
  },
);

export default router;
