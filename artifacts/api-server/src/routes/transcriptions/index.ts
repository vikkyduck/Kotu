import { stat } from "node:fs/promises";
import { Router, type IRouter } from "express";
import multer from "multer";
import { eq, and, desc, ne } from "drizzle-orm";
import {
  db,
  documentsTable,
  jobsTable,
  transcriptionsTable,
  type Transcription,
  type TranscriptSegment,
} from "@workspace/db";
import { UPLOAD_DIR } from "../../lib/paths";
import { syncTranscriptionDoc, deleteTranscriptionDoc } from "../../lib/transcript-doc";
import { decodeUploadName } from "../../lib/filename";
import { parseId } from "../../lib/parse-id";
import { resolveInsideDir } from "../../lib/uploads";
import {
  archiveAndRemove,
  archiveUpload,
  deleteJobsArchivingInput,
  requireArchive,
} from "../../lib/archive";
import type { TranscribePayload } from "../../lib/handlers/transcribe";
import {
  SEGMENTS_BUSY_MESSAGE,
  TRANSCRIPTION_WRITING,
  segmentsEditBlocked,
} from "../../lib/busy-edit";

// Long recordings (2–3 hours) are split server-side, so allow large uploads.
// Files are streamed to disk (not held in memory) and split with ffmpeg.
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

// Anything ffmpeg can decode is fine (it is re-encoded to mp3 before
// transcription), so accept a broad set of audio and video containers.
const ALLOWED_EXT =
  /\.(mp3|mp2|m4a|m4b|mp4|mov|wav|wave|aif|aiff|aac|ogg|oga|opus|webm|mkv|flac|amr|3gp|3gpp|wma|caf|mka|mpeg|mpga)$/i;

// Загруженное аудио должно пережить перезапуск сервера: задача из очереди может
// взяться за него уже после деплоя, а системный /tmp к тому времени вычистят.

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

const NOT_FOUND = "Расшифровка не найдена";

/** Запись строго своего владельца. Кривой id — как чужая запись: null, и ручка отвечает 404. */
async function loadTranscription(rawId: string, ownerId: number): Promise<Transcription | null> {
  const id = parseId(rawId);
  if (id === null) return null;
  const [row] = await db
    .select()
    .from(transcriptionsTable)
    .where(and(eq(transcriptionsTable.id, id), eq(transcriptionsTable.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/** Реплики из тела правки: только {who, text} строками — мусор в jsonb не пускаем. */
function parseSegments(raw: unknown): TranscriptSegment[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TranscriptSegment[] = [];
  for (const s of raw) {
    if (typeof s?.who !== "string" || typeof s?.text !== "string") return null;
    out.push({ who: s.who, text: s.text });
  }
  return out;
}

const router: IRouter = Router();

// Список нужен только библиотеке, и она перечитывает его каждые 3 с, пока
// что-то в работе, — без текста записей: полный текст отдаёт GET /:id.
router.get("/transcriptions", async (req, res): Promise<void> => {
  const rows = await db
    .select({
      id: transcriptionsTable.id,
      title: transcriptionsTable.title,
      status: transcriptionsTable.status,
      statusMessage: transcriptionsTable.statusMessage,
      progress: transcriptionsTable.progress,
      createdAt: transcriptionsTable.createdAt,
    })
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.ownerId, req.user!.id))
    .orderBy(desc(transcriptionsTable.createdAt));
  res.json(rows);
});

router.get("/transcriptions/:id", async (req, res): Promise<void> => {
  const row = await loadTranscription(req.params.id, req.user!.id);
  if (!row) {
    res.status(404).json({ message: NOT_FOUND });
    return;
  }

  res.json(row);
});

router.patch("/transcriptions/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ message: NOT_FOUND });
    return;
  }

  const body = req.body ?? {};
  const updates: Partial<typeof transcriptionsTable.$inferInsert> = {};
  if ("title" in body) {
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
    if (title === "") {
      res.status(400).json({ message: "Дайте записи название" });
      return;
    }
    updates.title = title;
  }
  if ("segments" in body) {
    const segments = parseSegments(body.segments);
    if (!segments) {
      res.status(400).json({ message: "Правка не сохранилась — обновите страницу" });
      return;
    }
    updates.segments = segments;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ message: "Нечего сохранять" });
    return;
  }

  // Текст, который сейчас пишет расшифровщик, не правим (lib/busy-edit.ts):
  // условие — в самом UPDATE, чтобы между проверкой и записью статус не
  // успел смениться.
  const [row] = await db
    .update(transcriptionsTable)
    .set(updates)
    .where(
      and(
        eq(transcriptionsTable.id, id),
        eq(transcriptionsTable.ownerId, req.user!.id),
        updates.segments !== undefined
          ? ne(transcriptionsTable.status, TRANSCRIPTION_WRITING)
          : undefined,
      ),
    )
    .returning();

  if (!row) {
    const [current] = await db
      .select({ status: transcriptionsTable.status })
      .from(transcriptionsTable)
      .where(and(eq(transcriptionsTable.id, id), eq(transcriptionsTable.ownerId, req.user!.id)));
    if (current && segmentsEditBlocked(current.status, updates)) {
      res.status(409).json({ message: SEGMENTS_BUSY_MESSAGE });
      return;
    }
    res.status(404).json({ message: NOT_FOUND });
    return;
  }

  // Правка текста должна доехать и до библиотечной копии — там переиндексация.
  // Смена одного названия текст не меняет: переразбирать копию (NER, векторы,
  // «В очереди…» на карточке) незачем. Со скрытием имён название копии
  // нейтральное и от названия записи не зависит; без скрытия — то же, что
  // даёт prepareLibraryCopy (title уже обрезан до 200 знаков).
  if (row.status === "done" && updates.segments !== undefined) {
    void syncTranscriptionDoc(row).catch((err) =>
      req.log.error({ err, id: row.id }, "Не смог обновить расшифровку в библиотеке"),
    );
  } else if (row.status === "done" && !row.hideNames) {
    await db
      .update(documentsTable)
      .set({ title: row.title })
      .where(
        and(eq(documentsTable.transcriptionId, row.id), eq(documentsTable.ownerId, row.ownerId)),
      )
      .catch((err) =>
        req.log.error({ err, id: row.id }, "Не смог обновить расшифровку в библиотеке"),
      );
  }

  res.json(row);
});

router.delete("/transcriptions/:id", async (req, res): Promise<void> => {
  // Чужую запись не трогаем даже косвенно: задачи и аудио ниже ищутся по id
  // записи без владельца, поэтому владельца проверяем заранее.
  const owned = await loadTranscription(req.params.id, req.user!.id);
  if (!owned) {
    res.status(404).json({ message: NOT_FOUND });
    return;
  }
  const id = owned.id;

  // Удаление убирает запись из рабочего пространства, но не стирает: строки
  // уходят в архив триггерами, файлы — archiveAndRemove (решение владелицы
  // 23.09.2026, ARCHITECTURE.md §10). Архив не готов — не трогаем ничего.
  await requireArchive();

  // Сначала библиотечная копия, потом сама запись. Упади уборка копии —
  // запись останется, и можно повторить; в обратном порядке копия зависала
  // бы сиротой до стартовой сверки.
  await deleteTranscriptionDoc(id, req.user!.id);

  // Затем задачи расшифровки и их аудио: ждущая задача иначе взялась бы за
  // удалённую запись. Сначала файлы, потом строки задач — не заархивируется
  // аудио, ссылки останутся и повтор удаления доделает; в обратном порядке
  // файл остался бы без хозяина.
  const jobs = await db
    .select({ payload: jobsTable.payload })
    .from(jobsTable)
    .where(and(eq(jobsTable.kind, "transcribe"), eq(jobsTable.entityId, id)));
  for (const job of jobs) {
    const audio = resolveInsideDir(UPLOAD_DIR, job.payload["inputPath"]);
    if (audio) {
      await archiveAndRemove(audio, {
        entityType: "transcription",
        entityId: id,
        originalName:
          typeof job.payload["filename"] === "string" ? job.payload["filename"] : null,
      });
    }
  }
  // Строки задач снимаются вместе с их payload в архив (имя файла записи,
  // настройки расшифровки) — одним оператором.
  await db.execute(deleteJobsArchivingInput("transcribe", "transcriptions", id));

  const [row] = await db
    .delete(transcriptionsTable)
    .where(
      and(
        eq(transcriptionsTable.id, id),
        eq(transcriptionsTable.ownerId, req.user!.id),
      ),
    )
    .returning();

  if (!row) {
    res.status(404).json({ message: NOT_FOUND });
    return;
  }

  res.sendStatus(204);
});

/**
 * Повтор проваленной расшифровки из сохранённого аудио — без новой загрузки.
 * Попытки задачи сжигает и деплой посреди работы, и сбой транзита, поэтому
 * «ошибка» часто не про файл, и заставлять заново грузить час записи незачем.
 */
router.post("/transcriptions/:id/retry", async (req, res): Promise<void> => {
  const row = await loadTranscription(req.params.id, req.user!.id);
  if (!row) {
    res.status(404).json({ message: NOT_FOUND });
    return;
  }
  const id = row.id;
  if (row.status !== "error") {
    res.status(409).json({ message: "Повторять нечего — ошибки нет" });
    return;
  }

  // Путь к аудио и настройки — из последней задачи: у проваленных payload
  // не затирается как раз ради такого повтора (lib/jobs.ts).
  const [lastJob] = await db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.kind, "transcribe"), eq(jobsTable.entityId, id)))
    .orderBy(desc(jobsTable.id))
    .limit(1);
  // Запись в ошибке, а задача ещё в очереди или в работе (рассинхрон после
  // сбоя между концом задачи и onGiveUp) — вторая задача на тот же файл
  // означала бы двойную расшифровку. Ждём, пока текущая закончит.
  if (lastJob && (lastJob.status === "queued" || lastJob.status === "running")) {
    res.status(409).json({ message: "Запись уже в работе" });
    return;
  }
  const prev = (lastJob?.payload ?? {}) as Partial<TranscribePayload>;
  const inputPath = resolveInsideDir(UPLOAD_DIR, prev.inputPath);
  const onDisk = inputPath
    ? await stat(inputPath).then((st) => st.isFile(), () => false)
    : false;
  if (!inputPath || !onDisk) {
    res
      .status(409)
      .json({ message: "Запись не сохранилась на сервере — загрузите запись заново" });
    return;
  }

  const payload: TranscribePayload = {
    inputPath,
    filename: typeof prev.filename === "string" ? prev.filename : row.filename,
    // Скрытие имён — строже из двух: если хоть где-то просили скрывать, скрываем.
    hideNames: prev.hideNames === true || row.hideNames,
    markSpeakers: typeof prev.markSpeakers === "boolean" ? prev.markSpeakers : row.markSpeakers,
  };

  // Смена статуса и новая задача — в одной транзакции: запись «в работе» без
  // задачи висела бы вечно. Условие status = 'error' в UPDATE закрывает
  // двойной клик — второй запрос не найдёт ошибки и не поставит вторую задачу.
  // Поэтому вставка прямо в jobs, а не через enqueue(): тот пишет мимо транзакции.
  // Так же — и загрузка ниже.
  const queued = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(transcriptionsTable)
      .set({ status: "processing", progress: 0, statusMessage: "В очереди…", error: null })
      .where(
        and(
          eq(transcriptionsTable.id, id),
          eq(transcriptionsTable.ownerId, req.user!.id),
          eq(transcriptionsTable.status, "error"),
        ),
      )
      .returning();
    if (!updated) return null;
    await tx.insert(jobsTable).values({
      kind: "transcribe",
      entityId: id,
      payload: payload as unknown as Record<string, unknown>,
    });
    return updated;
  });

  if (!queued) {
    res.status(409).json({ message: "Повторять нечего — ошибки нет" });
    return;
  }

  req.log.info({ id }, "Queued transcription retry");
  res.status(202).json(queued);
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
            .json({ message: "Файл слишком большой. Максимальный размер — 1 ГБ." });
          return;
        }
        if (err instanceof Error && err.message === "UNSUPPORTED_FILE_TYPE") {
          res
            .status(415)
            .json({ message: "Это не похоже на аудиозапись. Загрузите аудиофайл." });
          return;
        }
        req.log.warn({ err }, "Upload failed");
        res.status(400).json({ message: "Не удалось загрузить файл" });
        return;
      }
      next();
    });
  },
  async (req, res): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ message: "Не приложен аудиофайл" });
      return;
    }

    const hideNames = req.body?.hideNames === "true";
    const markSpeakers = req.body?.markSpeakers === "true";
    const filename = decodeUploadName(req.file.originalname) || "запись";
    const inputPath = req.file.path;
    // Название — до 200 знаков, как при переименовании (PATCH выше).
    const title = filename.replace(/\.[^.]+$/, "").trim().slice(0, 200) || "Запись";

    req.log.info({ filename, hideNames, markSpeakers }, "Queued transcription");

    // Работа уходит в очередь в базе: ответ не ждёт расшифровку, а сама задача
    // переживает перезапуск сервера и при сбое повторяется. Запись и задача —
    // в одной транзакции, как в повторе: запись «в работе» без задачи висела
    // бы вечно, а повтор её не берёт — он только для записей в ошибке.
    // «В очереди…» — пока задача ждёт; обработчик сам сменит на «Готовлю запись…».
    const payload: TranscribePayload = { inputPath, filename, hideNames, markSpeakers };
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
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
          statusMessage: "В очереди…",
        })
        .returning();
      await tx.insert(jobsTable).values({
        kind: "transcribe",
        entityId: created.id,
        payload: payload as unknown as Record<string, unknown>,
      });
      return created;
    });

    // Аудио — в архив файлов сразу после постановки (сам архив не бросает,
    // промах догонит сверка файлов): оно хранится, пока владелица не удалит
    // запись, и после удаления тоже остаётся в архиве.
    await archiveUpload(inputPath, {
      entityType: "transcription",
      entityId: row.id,
      originalName: filename,
      mime: req.file.mimetype,
    });

    res.status(201).json(row);
  },
);

export default router;
