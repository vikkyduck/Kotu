import { Router, type IRouter } from "express";
import multer from "multer";
import { eq, and, desc } from "drizzle-orm";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
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
import { enqueue } from "../../lib/jobs";
import { syncTranscriptionDoc, deleteTranscriptionDoc } from "../../lib/transcript-doc";
import { decodeUploadName } from "../../lib/filename";

// Long recordings (2–3 hours) are split server-side, so allow large uploads.
// Files are streamed to disk (not held in memory) and split with ffmpeg.
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

// Anything ffmpeg can decode is fine (it is re-encoded to mp3 before
// transcription), so accept a broad set of audio and video containers.
const ALLOWED_EXT =
  /\.(mp3|mp2|m4a|m4b|mp4|mov|wav|wave|aif|aiff|aac|ogg|oga|opus|webm|mkv|flac|amr|3gp|3gpp|wma|caf|mka|mpeg|mpga)$/i;

// Загруженное аудио должно пережить перезапуск сервера: задача из очереди может
// взяться за него уже после деплоя, а системный /tmp к тому времени вычистят.
const UPLOAD_DIR = process.env["UPLOAD_DIR"] ?? (process.env["NODE_ENV"] === "production" ? "/opt/kotu/uploads" : tmpdir());
mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
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

router.get("/transcriptions", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.ownerId, req.user!.id))
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
    .where(
      and(
        eq(transcriptionsTable.id, params.data.id),
        eq(transcriptionsTable.ownerId, req.user!.id),
      ),
    );

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
    .where(
      and(
        eq(transcriptionsTable.id, params.data.id),
        eq(transcriptionsTable.ownerId, req.user!.id),
      ),
    )
    .returning();

  if (!row) {
    res.status(404).json({ error: "Расшифровка не найдена" });
    return;
  }

  // Правка текста должна доехать и до библиотечной копии — там переиндексация.
  if (row.status === "done") {
    void syncTranscriptionDoc(row).catch((err) =>
      req.log.error({ err, id: row.id }, "Не смог обновить расшифровку в библиотеке"),
    );
  }

  res.json(UpdateTranscriptionResponse.parse(row));
});

router.delete("/transcriptions/:id", async (req, res): Promise<void> => {
  const params = DeleteTranscriptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Уничтожение — без остатков (§10): сначала библиотечная копия, потом сама
  // запись. Упади чистка копии — запись останется, и можно повторить; в
  // обратном порядке копия зависала бы сиротой до стартовой сверки.
  await deleteTranscriptionDoc(params.data.id, req.user!.id);

  const [row] = await db
    .delete(transcriptionsTable)
    .where(
      and(
        eq(transcriptionsTable.id, params.data.id),
        eq(transcriptionsTable.ownerId, req.user!.id),
      ),
    )
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
    const filename = decodeUploadName(req.file.originalname) || "запись";
    const inputPath = req.file.path;
    const title = filename.replace(/\.[^.]+$/, "") || "Запись";

    req.log.info({ filename, hideNames, markSpeakers }, "Queued transcription");

    const [row] = await db
      .insert(transcriptionsTable)
      .values({
        ownerId: req.user!.id,
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

    // Работа уходит в очередь в базе: ответ не ждёт расшифровку, а сама задача
    // переживает перезапуск сервера и при сбое повторяется.
    await enqueue("transcribe", row.id, { inputPath, filename, hideNames, markSpeakers });

    res.status(201).json(GetTranscriptionResponse.parse(row));
  },
);

export default router;
