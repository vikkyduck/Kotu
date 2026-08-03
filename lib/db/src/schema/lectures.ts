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
  /**
   * Акцент лекции — из промпта автора: что важнее в этот раз. Меняет и план,
   * и тон глав: клиника тянет к случаям и технике, теория к концептуальному
   * аппарату, история к генезису понятия и датам.
   */
  focus?: "clinical" | "theoretical" | "historical";
  /**
   * Откуда материал: 'library' — из выбранных документов библиотеки (как
   * всегда было; отсутствие поля читается так же), 'research' — библиотека
   * не обязательна, модель исследует тему сама: через веб-поиск с источниками,
   * а без настроенного поиска — по собственным знаниям с честной пометкой.
   */
  mode?: "library" | "research";
}

/**
 * Один блок плана — до того, как он написан. Состав задан методикой автора:
 * тезис, опорные концепции с авторами и «крючок» — вопрос, который держит
 * внимание профессиональной аудитории.
 */
export interface PlannedSection {
  heading: string;
  /** Тезис блока: одно-два предложения. */
  abstract: string;
  /** Опорные концепции и авторы этого блока. */
  concepts?: string[];
  /** Клинический или теоретический «крючок» — вопрос для аудитории. */
  hook?: string;
}

/**
 * То, что сопровождает план и требует авторского решения ДО написания текста:
 * что сознательно вынесено за скобки и где нужно занять позицию.
 */
export interface LecturePlanNotes {
  outOfScope: string[];
  decisions: string[];
}

/** Литература двумя уровнями — как просит методика: истоки и современность. */
export interface Bibliography {
  primary: string[];
  modern: string[];
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
  /** Спутники плана: что за скобками и какие решения ждут автора. */
  planNotes: jsonb("plan_notes").$type<LecturePlanNotes | null>(),
  /** Список литературы двумя уровнями — собирается после написания глав. */
  bibliography: jsonb("bibliography").$type<Bibliography | null>(),
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
    /** doc — фрагмент библиотеки, web — найдено поиском, model — знания модели. */
    kind: text("kind").$type<"doc" | "web" | "model">().notNull().default("doc"),
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
