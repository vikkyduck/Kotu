import { stat } from "node:fs/promises";
import path from "node:path";
import { Router, type IRouter } from "express";
import multer from "multer";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import {
  db,
  documentsTable,
  foldersTable,
  jobsTable,
  lecturesTable,
  decksTable,
  type Document,
} from "@workspace/db";
import { enqueue } from "../../lib/jobs";
import { LIBRARY_DIR } from "../../lib/paths";
import { embedAll } from "../../lib/embeddings";
import { ownFolderId } from "../../lib/folders";
import { attachmentHeader, decodeUploadName } from "../../lib/filename";
import { parseId } from "../../lib/parse-id";
import { resolveInsideDir } from "../../lib/uploads";
import { archiveAndRemove, archiveUpload, requireArchive } from "../../lib/archive";
import { logger } from "../../lib/logger";

// Книги бывают толстыми, но не гигабайтными.
const MAX_FILE_BYTES = 200 * 1024 * 1024;

// Ровно то, что умеет разобрать extractText (lib/documents.ts): RTF, например,
// ушёл бы туда «как текст» и лёг в поиск разметкой {\rtf1…}.
const ALLOWED_EXT = /\.(pdf|docx|epub|txt|md|markdown|html?)$/i;

const upload = multer({
  dest: LIBRARY_DIR,
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_EXT.test(file.originalname)) {
      cb(null, true);
      return;
    }
    cb(new Error("UNSUPPORTED_FILE_TYPE"));
  },
});

const router: IRouter = Router();

router.get("/documents", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(documentsTable)
    .where(eq(documentsTable.ownerId, req.user!.id))
    .orderBy(desc(documentsTable.createdAt));
  res.json(rows);
});

/** Документ автора по номеру из адреса; чужой, удалённый и кривой номер — null (404). */
async function ownDoc(rawId: unknown, ownerId: number): Promise<Document | null> {
  const id = parseId(rawId);
  if (id === null) return null;
  const [doc] = await db
    .select()
    .from(documentsTable)
    .where(and(eq(documentsTable.id, id), eq(documentsTable.ownerId, ownerId)))
    .limit(1);
  return doc ?? null;
}

/** Последняя задача разбора документа: в её payload — путь к файлу и исходное имя. */
async function lastIngest(docId: number) {
  const [job] = await db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.kind, "doc.ingest"), eq(jobsTable.entityId, docId)))
    .orderBy(desc(jobsTable.id))
    .limit(1);
  return job ?? null;
}

interface IngestPayload {
  sourcePath: string;
  mime: string;
  filename: string;
}

/**
 * Во вкладке открываются только PDF и простой текст — с типом, заданным здесь,
 * а не присланным при загрузке. Остальное скачивается: сохранённая из
 * интернета HTML-страница, открытая inline, запустила бы чужие скрипты на
 * домене приложения — с доступом ко всей библиотеке через cookie владелицы.
 */
const INLINE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  markdown: "text/plain; charset=utf-8",
};

/** Сам загруженный файл — открыть во вкладке или скачать под исходным именем. */
router.get("/documents/:id/file", async (req, res): Promise<void> => {
  const doc = await ownDoc(req.params.id, req.user!.id);
  const file = doc ? resolveInsideDir(LIBRARY_DIR, doc.sourcePath) : null;
  const onDisk = file ? await stat(file).then((st) => st.isFile(), () => false) : false;
  if (!doc || !file || !onDisk) {
    res.status(404).json({ message: "Файл не найден" });
    return;
  }
  const prev = (await lastIngest(doc.id))?.payload as Partial<IngestPayload> | undefined;
  const ext = path.extname(typeof prev?.filename === "string" ? prev.filename : "").slice(1).toLowerCase();
  const inlineType = INLINE_TYPES[ext];
  const disposition = ext ? attachmentHeader(doc.title, ext, "document") : "attachment";
  res.sendFile(file, {
    headers: {
      "Content-Type": inlineType ?? "application/octet-stream",
      "Content-Disposition": inlineType ? disposition.replace(/^attachment/, "inline") : disposition,
      "X-Content-Type-Options": "nosniff",
    },
  });
});

/**
 * Разобрать документ заново — после ошибки. Очередь сама делает три попытки
 * за пару минут; если причина была дольше (лежал сервис векторов), без
 * повтора оставалось только удалить книгу и загрузить снова.
 */
router.post("/documents/:id/retry", async (req, res): Promise<void> => {
  const doc = await ownDoc(req.params.id, req.user!.id);
  if (!doc) {
    res.status(404).json({ message: "Документ не найден" });
    return;
  }
  if (doc.status !== "error") {
    res.status(409).json({ message: "Повторять нечего — ошибки нет" });
    return;
  }
  const lastJob = await lastIngest(doc.id);
  // Документ в ошибке, а задача ещё в очереди или в работе — вторая задача
  // на тот же файл разбирала бы его дважды. Ждём, пока текущая закончит.
  if (lastJob && (lastJob.status === "queued" || lastJob.status === "running")) {
    res.status(409).json({ message: "Документ уже в работе" });
    return;
  }
  const prev = (lastJob?.payload ?? {}) as Partial<IngestPayload>;
  const sourcePath = resolveInsideDir(LIBRARY_DIR, prev.sourcePath ?? doc.sourcePath);
  const onDisk = sourcePath
    ? await stat(sourcePath).then((st) => st.isFile(), () => false)
    : false;
  if (!sourcePath || !onDisk) {
    res.status(409).json({ message: "Файл не сохранился на сервере — загрузите его заново" });
    return;
  }
  const payload: IngestPayload = {
    sourcePath,
    mime: typeof prev.mime === "string" ? prev.mime : doc.mime,
    filename: typeof prev.filename === "string" ? prev.filename : doc.title,
  };

  // Статус и задача — в одной транзакции: документ «в разборе» без задачи
  // висел бы вечно. Условие status = 'error' в UPDATE закрывает двойной клик.
  const queued = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(documentsTable)
      .set({ status: "parsing", statusMessage: "В очереди…", error: null })
      .where(and(eq(documentsTable.id, doc.id), eq(documentsTable.status, "error")))
      .returning();
    if (!updated) return null;
    await tx.insert(jobsTable).values({
      kind: "doc.ingest",
      entityId: doc.id,
      payload: payload as unknown as Record<string, unknown>,
    });
    return updated;
  });
  if (!queued) {
    res.status(409).json({ message: "Повторять нечего — ошибки нет" });
    return;
  }
  res.status(202).json(queued);
});

router.delete("/documents/:id", async (req, res): Promise<void> => {
  const doc = await ownDoc(req.params.id, req.user!.id);
  if (!doc) {
    res.status(404).json({ message: "Документ не найден" });
    return;
  }

  // Библиотечная копия расшифровки живёт, пока жива запись: удалишь отсюда —
  // стартовая сверка вернёт её. Удалять надо саму запись на её экране.
  if (doc.kind === "transcript") {
    res.status(409).json({ message: "Это расшифровка — удаляется вместе с записью на её экране" });
    return;
  }

  // Удаление убирает документ из библиотеки, но не стирает: файл сначала в
  // архив (не вышло — исключение, ничего не удалено), строка уходит в архив
  // триггером. Фрагменты поиска уходят каскадом — это индекс, не данные.
  await requireArchive();
  await archiveAndRemove(doc.sourcePath, {
    entityType: "document",
    entityId: doc.id,
    originalName: doc.title,
    mime: doc.mime,
  });
  await db.delete(documentsTable).where(eq(documentsTable.id, doc.id));
  res.sendStatus(204);
});

/** Переложить документ в папку (или вынуть: folderId null) и переименовать. */
router.patch("/documents/:id", async (req, res): Promise<void> => {
  const doc = await ownDoc(req.params.id, req.user!.id);
  if (!doc) {
    res.status(404).json({ message: "Документ не найден" });
    return;
  }

  const body = req.body ?? {};
  const patch: Partial<typeof documentsTable.$inferInsert> = {};

  if ("folderId" in body) {
    const folderId = await ownFolderId(body.folderId, req.user!.id);
    if (folderId === undefined) {
      res.status(404).json({ message: "Папка не найдена" });
      return;
    }
    patch.folderId = folderId;
  }
  if (typeof body.title === "string" && body.title.trim() !== "") {
    // У библиотечной копии расшифровки имя нейтральное и своё: правка здесь
    // перезатёрлась бы следующей синхронизацией, а имя из зоны А сюда нельзя.
    if (doc.kind === "transcript") {
      res.status(400).json({ message: "Расшифровку переименовывают как запись, а не как копию" });
      return;
    }
    patch.title = body.title.trim().slice(0, 200);
  }

  if (Object.keys(patch).length > 0) {
    await db.update(documentsTable).set(patch).where(eq(documentsTable.id, doc.id));
  }
  res.json({ ok: true });
});

// ── Папки: способ автора раскладывать библиотеку по темам ────────────────────

router.get("/folders", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(foldersTable)
    .where(eq(foldersTable.ownerId, req.user!.id))
    .orderBy(foldersTable.name);
  res.json(rows);
});

router.post("/folders", async (req, res): Promise<void> => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 100) : "";
  if (name === "") {
    res.status(400).json({ message: "Дайте папке имя" });
    return;
  }
  const existing = await db
    .select({ id: foldersTable.id })
    .from(foldersTable)
    .where(eq(foldersTable.ownerId, req.user!.id));
  if (existing.length >= 50) {
    res.status(400).json({ message: "Папок уже пятьдесят — дальше библиотека перестанет быть обозримой" });
    return;
  }
  const [folder] = await db
    .insert(foldersTable)
    .values({ ownerId: req.user!.id, name })
    .returning();
  res.status(201).json(folder);
});

router.patch("/folders/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 100) : "";
  if (name === "") {
    res.status(400).json({ message: "Дайте папке имя" });
    return;
  }
  const [row] = Number.isInteger(id)
    ? await db
        .update(foldersTable)
        .set({ name })
        .where(and(eq(foldersTable.id, id), eq(foldersTable.ownerId, req.user!.id)))
        .returning()
    : [];
  if (!row) {
    res.status(404).json({ message: "Папка не найдена" });
    return;
  }
  res.json(row);
});

router.delete("/folders/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  // Строка папки уходит в архив триггером — без архива не удаляем.
  await requireArchive();
  const ownerId = req.user!.id;
  const row = Number.isInteger(id)
    ? await db.transaction(async (tx) => {
        const [folder] = await tx
          .delete(foldersTable)
          .where(and(eq(foldersTable.id, id), eq(foldersTable.ownerId, ownerId)))
          .returning();
        if (!folder) return null;
        // Документы выносит «без папки» внешний ключ (set null), а у лекций и
        // презентаций ключа нет: без этого они ссылались бы на исчезнувшую
        // папку и пропадали из библиотеки — ни в корне, ни в папке.
        await tx
          .update(lecturesTable)
          .set({ folderId: null })
          .where(and(eq(lecturesTable.folderId, id), eq(lecturesTable.ownerId, ownerId)));
        await tx
          .update(decksTable)
          .set({ folderId: null })
          .where(and(eq(decksTable.folderId, id), eq(decksTable.ownerId, ownerId)));
        return folder;
      })
    : null;
  if (!row) {
    res.status(404).json({ message: "Папка не найдена" });
    return;
  }
  res.sendStatus(204);
});

router.post(
  "/documents",
  (req, res, next) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      const code = (err as { code?: string }).code;
      if (code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ message: "Файл больше 200 МБ — это слишком много." });
        return;
      }
      if (err instanceof Error && err.message === "UNSUPPORTED_FILE_TYPE") {
        res.status(415).json({
          message: "Такой формат не читаю. Подойдут PDF, DOCX, EPUB, TXT, MD, HTML.",
        });
        return;
      }
      req.log.warn({ err }, "Не удалось загрузить документ");
      res.status(400).json({ message: "Не удалось загрузить файл" });
    });
  },
  async (req, res): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ message: "Файл не приложен" });
      return;
    }

    const filename = decodeUploadName(req.file.originalname) || "документ";
    const title =
      typeof req.body?.title === "string" && req.body.title.trim() !== ""
        ? req.body.title.trim()
        : filename.replace(/\.[^.]+$/, "");
    // 'transcript' зарезервирован за автоматическими копиями расшифровок:
    // рукотворный файл с таким kind стал бы неудаляемым.
    const kind = ["book", "article", "note"].includes(req.body?.kind)
      ? req.body.kind
      : "book";

    // Файл можно бросить сразу на папку — тогда он и уляжется в неё, без
    // второго действия «а теперь переложи». Чужая папка молча игнорируется.
    const folderId = (await ownFolderId(req.body?.folderId, req.user!.id)) ?? null;

    const [doc] = await db
      .insert(documentsTable)
      .values({
        ownerId: req.user!.id,
        folderId,
        title,
        kind,
        sourcePath: req.file.path,
        mime: req.file.mimetype,
        status: "parsing",
        statusMessage: "В очереди…",
      })
      .returning();

    await archiveUpload(req.file.path, {
      entityType: "document",
      entityId: doc.id,
      originalName: filename,
      mime: req.file.mimetype,
    });

    await enqueue("doc.ingest", doc.id, {
      sourcePath: req.file.path,
      mime: req.file.mimetype,
      filename,
    });

    res.status(201).json(doc);
  },
);

/**
 * Поиск по библиотеке: гибрид смысла и слов. Вектор находит близкое по смыслу
 * даже другими словами, полнотекст — точные термины и имена, которые вектор
 * иногда «сглаживает». Вместе они дают заметно лучший результат, чем поодиночке.
 */
export async function searchLibrary(
  ownerId: number,
  queryVector: number[],
  queryText: string,
  limit = 12,
  documentIds?: number[],
): Promise<{ id: number; documentId: number; text: string; heading: string | null; title: string; score: number }[]> {
  const vec = `[${queryVector.join(",")}]`;
  const docFilter =
    documentIds && documentIds.length > 0
      ? sql`AND d.id = ANY(${sql.raw(`ARRAY[${documentIds.join(",")}]`)})`
      : sql``;

  const { rows } = await db.execute<{
    id: number;
    document_id: number;
    text: string;
    heading: string | null;
    title: string;
    score: number;
  }>(sql`
    SELECT c.id, c.document_id, c.text, c.heading, d.title,
           (1 - (c.embedding <=> ${vec}::vector)) * 0.75
           + ts_rank(to_tsvector('russian', c.text),
                     plainto_tsquery('russian', ${queryText})) * 0.25 AS score
    FROM doc_chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.owner_id = ${ownerId} AND c.embedding IS NOT NULL ${docFilter}
    ORDER BY score DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    text: r.text,
    heading: r.heading,
    title: r.title,
    score: Number(r.score),
  }));
}

/**
 * Поиск по всей библиотеке — для человека, а не только для лекций. Ищет по
 * книгам, расшифровкам, готовым лекциям и презентациям: всё, что попало в
 * индекс. Фрагменты группируем по материалу — автору важно, ГДЕ нашлось.
 */
router.get("/search", async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) {
    res.json({ results: [] });
    return;
  }

  // Сервис векторов лежит — embedAll бросает; без перехвата клиент получил
  // бы голую 500 вместо понятной фразы ниже.
  const [vector] = await embedAll([q], undefined, "query").catch((err: unknown) => {
    logger.warn({ err }, "Поиск: не удалось посчитать вектор запроса");
    return [];
  });
  if (!vector) {
    res.status(503).json({ message: "Поиск сейчас недоступен — попробуйте чуть позже" });
    return;
  }

  const hits = await searchLibrary(req.user!.id, vector, q, 24);
  const docIds = [...new Set(hits.map((h) => h.documentId))];
  const docs = docIds.length
    ? await db
        .select({
          id: documentsTable.id,
          kind: documentsTable.kind,
          lectureId: documentsTable.lectureId,
          deckId: documentsTable.deckId,
          transcriptionId: documentsTable.transcriptionId,
        })
        .from(documentsTable)
        .where(inArray(documentsTable.id, docIds))
    : [];
  const byId = new Map(docs.map((d) => [d.id, d]));

  // По три лучших фрагмента на материал: страница выдачи должна читаться,
  // а не превращаться в простыню из одной книги.
  const grouped = new Map<number, { documentId: number; title: string; kind: string;
    lectureId: number | null; deckId: number | null; transcriptionId: number | null;
    score: number; quotes: { text: string; heading: string | null }[] }>();
  for (const h of hits) {
    const doc = byId.get(h.documentId);
    if (!doc) continue;
    const g = grouped.get(h.documentId) ?? {
      documentId: h.documentId,
      title: h.title,
      kind: doc.kind,
      lectureId: doc.lectureId,
      deckId: doc.deckId,
      transcriptionId: doc.transcriptionId,
      score: h.score,
      quotes: [],
    };
    if (g.quotes.length < 3) g.quotes.push({ text: h.text.slice(0, 600), heading: h.heading });
    grouped.set(h.documentId, g);
  }

  res.json({ results: [...grouped.values()].sort((a, b) => b.score - a.score).slice(0, 8) });
});

export default router;
