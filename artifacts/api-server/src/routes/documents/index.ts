import { Router, type IRouter } from "express";
import multer from "multer";
import { eq, and, desc, sql } from "drizzle-orm";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { db, documentsTable, docChunksTable, foldersTable } from "@workspace/db";
import { enqueue } from "../../lib/jobs";
import { decodeUploadName } from "../../lib/filename";

// Книги бывают толстыми, но не гигабайтными.
const MAX_FILE_BYTES = 200 * 1024 * 1024;

const ALLOWED_EXT = /\.(pdf|docx|epub|txt|md|markdown|html?|rtf)$/i;

const LIBRARY_DIR =
  process.env["LIBRARY_DIR"] ??
  (process.env["NODE_ENV"] === "production" ? "/opt/kotu/library" : tmpdir());
mkdirSync(LIBRARY_DIR, { recursive: true });

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

router.get("/documents/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ message: "Неверный адрес документа" });
    return;
  }

  const [doc] = await db
    .select()
    .from(documentsTable)
    .where(and(eq(documentsTable.id, id), eq(documentsTable.ownerId, req.user!.id)))
    .limit(1);

  if (!doc) {
    res.status(404).json({ message: "Документ не найден" });
    return;
  }
  res.json(doc);
});

router.delete("/documents/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Документ не найден" });
    return;
  }
  const [doc] = await db
    .select()
    .from(documentsTable)
    .where(and(eq(documentsTable.id, id), eq(documentsTable.ownerId, req.user!.id)))
    .limit(1);

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

  // Фрагменты уходят каскадом, файл убираем руками — без «мягкого удаления»:
  // удалили значит удалили.
  await db.delete(documentsTable).where(eq(documentsTable.id, id));
  await rm(doc.sourcePath, { force: true }).catch(() => {});
  res.sendStatus(204);
});

/** Переложить документ в папку (или вынуть: folderId null). */
router.patch("/documents/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [doc] = Number.isInteger(id)
    ? await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.id, id), eq(documentsTable.ownerId, req.user!.id)))
        .limit(1)
    : [];
  if (!doc) {
    res.status(404).json({ message: "Документ не найден" });
    return;
  }

  const body = req.body ?? {};
  const patch: Partial<typeof documentsTable.$inferInsert> = {};

  if ("folderId" in body) {
    if (body.folderId === null) {
      patch.folderId = null;
    } else {
      const folderId = Number(body.folderId);
      const [folder] = Number.isInteger(folderId)
        ? await db
            .select({ id: foldersTable.id })
            .from(foldersTable)
            .where(and(eq(foldersTable.id, folderId), eq(foldersTable.ownerId, req.user!.id)))
            .limit(1)
        : [];
      if (!folder) {
        res.status(404).json({ message: "Папка не найдена" });
        return;
      }
      patch.folderId = folder.id;
    }
  }
  if (typeof body.title === "string" && body.title.trim() !== "") {
    // У библиотечной копии расшифровки имя нейтральное и своё: правка здесь
    // перезатёрлась бы следующей синхронизацией, а имя из зоны А сюда нельзя.
    if (doc.kind === "transcript") {
      res.status(400).json({ message: "Переименуйте саму запись — на её экране" });
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
  const [row] = Number.isInteger(id)
    ? await db
        .delete(foldersTable)
        .where(and(eq(foldersTable.id, id), eq(foldersTable.ownerId, req.user!.id)))
        .returning()
    : [];
  if (!row) {
    res.status(404).json({ message: "Папка не найдена" });
    return;
  }
  // Документы остаются «без папки» — FK set null сделал своё.
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

    const [doc] = await db
      .insert(documentsTable)
      .values({
        ownerId: req.user!.id,
        title,
        kind,
        sourcePath: req.file.path,
        mime: req.file.mimetype,
        status: "parsing",
        statusMessage: "В очереди…",
      })
      .returning();

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

export default router;
