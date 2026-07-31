import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { docChunksTable } from "./documents";

export type LectureStatus =
  | "planning"
  | "plan_ready"
  | "writing"
  | "ready"
  | "error";

/** Что человек попросил: тема своими словами и рамки. */
export interface LectureBrief {
  topic: string;
  audience: string;
  durationMin: number;
  mustInclude?: string;
  mustAvoid?: string;
  documentIds: number[];
}

/** Одна глава в плане — до того, как она написана. */
export interface PlannedSection {
  heading: string;
  abstract: string;
}

export const lecturesTable = pgTable("lectures", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  /**
   * Папка библиотеки. Библиотека — главная папка всей работы, а не полка для
   * одних лишь книг: лекция лежит рядом с материалом, из которого сделана.
   */
  folderId: integer("folder_id"),
  brief: jsonb("brief").$type<LectureBrief>().notNull(),
  plan: jsonb("plan").$type<PlannedSection[]>(),
  /**
   * Человек в цикле: пока план не утверждён, ни одна глава не пишется.
   * Согласовать структуру дешевле, чем переписывать шесть часов текста.
   */
  planApproved: boolean("plan_approved").notNull().default(false),
  status: text("status").$type<LectureStatus>().notNull().default("planning"),
  statusMessage: text("status_message").notNull().default(""),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type SectionStatus = "pending" | "writing" | "ready" | "error";

export const lectureSectionsTable = pgTable(
  "lecture_sections",
  {
    id: serial("id").primaryKey(),
    lectureId: integer("lecture_id")
      .notNull()
      .references(() => lecturesTable.id, { onDelete: "cascade" }),
    ord: integer("ord").notNull(),
    heading: text("heading").notNull(),
    abstract: text("abstract").notNull().default(""),
    text: text("text").notNull().default(""),
    /** Правку автора перезаписывать нельзя — даже при перегенерации соседних глав. */
    editedByHuman: boolean("edited_by_human").notNull().default(false),
    status: text("status").$type<SectionStatus>().notNull().default("pending"),
  },
  (t) => ({
    byLecture: index("lecture_sections_lecture_idx").on(t.lectureId, t.ord),
  }),
);

/**
 * Источник под утверждением: точная цитата и откуда она.
 * Для академической аудитории это обязательно, а заодно защищает от выдумок:
 * цитату всегда можно открыть и сверить.
 */
export const lectureSourcesTable = pgTable(
  "lecture_sources",
  {
    id: serial("id").primaryKey(),
    lectureId: integer("lecture_id")
      .notNull()
      .references(() => lecturesTable.id, { onDelete: "cascade" }),
    sectionId: integer("section_id").references(() => lectureSectionsTable.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").$type<"doc" | "web">().notNull().default("doc"),
    chunkId: integer("chunk_id"),
    url: text("url"),
    title: text("title").notNull(),
    quote: text("quote").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byLecture: index("lecture_sources_lecture_idx").on(t.lectureId),
  }),
);

export type Lecture = typeof lecturesTable.$inferSelect;
export type LectureSection = typeof lectureSectionsTable.$inferSelect;
export type LectureSource = typeof lectureSourcesTable.$inferSelect;
