import {
  pgTable,
  serial,
  integer,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export type DeckStatus =
  | "storyboarding"
  | "storyboard_ready"
  | "drawing"
  | "ready"
  | "error";

export type SourceKind = "lecture" | "document" | "raw";

/** Набор макетов ограничен намеренно: это и есть залог единого вида серии. */
export type SlideLayout =
  | "title"
  | "section"
  | "bullets"
  | "two-cards"
  | "quote"
  | "diagram"
  | "image-full"
  | "closing";

/** Содержимое слайда. Поля необязательные: у каждого макета свои. */
export interface SlideContent {
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  bullets?: string[];
  cards?: { title: string; body: string }[];
  quote?: string;
  attribution?: string;
  footnote?: string;
}

export const decksTable = pgTable("decks", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sourceKind: text("source_kind").$type<SourceKind>().notNull(),
  /** id лекции или документа; для вставленного текста — null. */
  sourceId: integer("source_id"),
  stylePackId: integer("style_pack_id"),
  status: text("status").$type<DeckStatus>().notNull().default("storyboarding"),
  statusMessage: text("status_message").notNull().default(""),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ImageStatus = "none" | "queued" | "drawing" | "ready" | "error";

export const deckSlidesTable = pgTable(
  "deck_slides",
  {
    id: serial("id").primaryKey(),
    deckId: integer("deck_id")
      .notNull()
      .references(() => decksTable.id, { onDelete: "cascade" }),
    ord: integer("ord").notNull(),
    layout: text("layout").$type<SlideLayout>().notNull().default("bullets"),
    content: jsonb("content").$type<SlideContent>().notNull(),
    /** Заметки докладчику — то, что говорят, а не показывают. */
    notes: text("notes").notNull().default(""),
    /**
     * Мысль, которую должна нести иллюстрация. Пишет Claude — он отвечает за
     * содержание. Сюжет по этой мысли придумывает уже Gemini отдельным шагом.
     */
    imageBrief: text("image_brief"),
    /** Сюжет сцены, придуманный по мысли: что изображено и как построено. */
    imageScene: text("image_scene"),
    imagePath: text("image_path"),
    imageStatus: text("image_status").$type<ImageStatus>().notNull().default("none"),
    imageAttempt: integer("image_attempt").notNull().default(0),
    /** Что сказала приёмка: почему приняли или отправили на перерисовку. */
    imageVerdict: text("image_verdict"),
    /** Описание схемы для тех слайдов, где нужна не метафора, а структура. */
    diagramSpec: jsonb("diagram_spec"),
  },
  (t) => ({
    byDeck: index("deck_slides_deck_idx").on(t.deckId, t.ord),
  }),
);

/**
 * Визуальный язык серии. Жёсткая часть промпта живёт здесь, а не в коде:
 * стиль — вопрос вкуса автора, его меняют без правки приложения.
 */
export const stylePacksTable = pgTable("style_packs", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  promptSuffix: text("prompt_suffix").notNull(),
  negative: text("negative").notNull().default(""),
  palette: text("palette").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Deck = typeof decksTable.$inferSelect;
export type DeckSlide = typeof deckSlidesTable.$inferSelect;
export type StylePack = typeof stylePacksTable.$inferSelect;
