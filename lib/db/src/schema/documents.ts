import {
  pgTable,
  serial,
  bigserial,
  integer,
  text,
  timestamp,
  index,
  vector,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export type DocumentKind = "book" | "article" | "note" | "transcript";
export type DocumentStatus = "uploaded" | "parsing" | "ready" | "error";

/** Книга, статья или заметка, на которые опираются лекции. Зона Б: не персональные данные. */
export const documentsTable = pgTable("documents", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  kind: text("kind").$type<DocumentKind>().notNull().default("book"),
  /** Путь к исходному файлу на диске сервера. */
  sourcePath: text("source_path").notNull(),
  mime: text("mime").notNull(),
  pages: integer("pages"),
  chunkCount: integer("chunk_count").notNull().default(0),
  status: text("status").$type<DocumentStatus>().notNull().default("uploaded"),
  statusMessage: text("status_message").notNull().default(""),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Фрагмент документа с эмбеддингом. Размер ~1000 знаков: достаточно, чтобы
 * фрагмент был осмысленным сам по себе, и достаточно мало, чтобы цитата была
 * точной, а не «где-то на этой странице».
 *
 * 1536 измерений — text-embedding-3-small. Модель эмбеддингов менять нельзя
 * без переиндексации всей библиотеки: векторы разных моделей несопоставимы.
 */
export const docChunksTable = pgTable(
  "doc_chunks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentId: integer("document_id")
      .notNull()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    ord: integer("ord").notNull(),
    page: integer("page"),
    heading: text("heading"),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
  },
  (t) => ({
    byDoc: index("doc_chunks_doc_idx").on(t.documentId, t.ord),
  }),
);

export type Document = typeof documentsTable.$inferSelect;
export type DocChunk = typeof docChunksTable.$inferSelect;
