import { Router, type IRouter } from "express";
import multer from "multer";
import { eq, and, desc, sql } from "drizzle-orm";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { db, documentsTable, docChunksTable } from "@workspace/db";
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
  const [doc] = await db
    .select()
    .from(documentsTable)
    .where(and(eq(documentsTable.id, id), eq(documentsTable.ownerId, req.user!.id)))
    .limit(1);

  if (!doc) {
    res.status(404).json({ message: "Документ не найден" });
    return;
  }

  // Фрагменты уходят каскадом, файл убираем руками — без «мягкого удаления»:
  // удалили значит удалили.
  await db.delete(documentsTable).where(eq(documentsTable.id, id));
  await rm(doc.sourcePath, { force: true }).catch(() => {});
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
    const kind = ["book", "article", "note", "transcript"].includes(req.body?.kind)
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
