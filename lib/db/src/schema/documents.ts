import {
  pgTable,
  serial,
  bigserial,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export type DocumentKind = "book" | "article" | "note" | "transcript";
export type DocumentStatus = "uploaded" | "parsing" | "ready" | "error";

/** Папка библиотеки — способ автора раскладывать материал по темам. */
export const foldersTable = pgTable("folders", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Книга, статья или заметка, на которые опираются лекции. Зона Б: не персональные данные. */
export const documentsTable = pgTable("documents", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  /** Папка. Удаление папки не трогает документы — они остаются «без папки». */
  folderId: integer("folder_id").references(() => foldersTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  kind: text("kind").$type<DocumentKind>().notNull().default("book"),
  /**
   * Для kind='transcript' — из какой расшифровки собран документ. В библиотеку
   * расшифровка попадает ТОЛЬКО в маскированном виде (правило двух зон):
   * файл и эмбеддинги — с плейсхолдерами вместо имён.
   */
  transcriptionId: integer("transcription_id"),
  /** Путь к исходному файлу на диске сервера. */
  sourcePath: text("source_path").notNull(),
  mime: text("mime").notNull(),
  pages: integer("pages"),
  chunkCount: integer("chunk_count").notNull().default(0),
  status: text("status").$type<DocumentStatus>().notNull().default("uploaded"),
  statusMessage: text("status_message").notNull().default(""),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
},
(t) => ({
  // Одна расшифровка — одна библиотечная копия: check-then-insert без
  // уникальности превращался в гонку с неудаляемыми дубликатами.
  byTranscription: uniqueIndex("documents_transcription_uniq")
    .on(t.transcriptionId)
    .where(sql`transcription_id IS NOT NULL`),
}));

export type Folder = typeof foldersTable.$inferSelect;

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
    embedding: vector("embedding", { dimensions: 1024 }),
  },
  (t) => ({
    byDoc: index("doc_chunks_doc_idx").on(t.documentId, t.ord),
  }),
);

export type Document = typeof documentsTable.$inferSelect;
export type DocChunk = typeof docChunksTable.$inferSelect;
