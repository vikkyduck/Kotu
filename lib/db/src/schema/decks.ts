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
  /**
   * Человек в цикле, как и с планом лекции: пока раскадровка не утверждена,
   * не рисуется ни одна картинка. Здесь ставка выше, чем в лекциях, — каждая
   * иллюстрация это время и деньги, а их в презентации десяток.
   */
  storyboardApproved: boolean("storyboard_approved").notNull().default(false),
  status: text("status").$type<DeckStatus>().notNull().default("storyboarding"),
  statusMessage: text("status_message").notNull().default(""),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
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
    /**
     * Выбранная картинка из deck_images. Внешнего ключа нет намеренно: ссылка
     * идёт в обе стороны, и FK замкнул бы таблицы в цикл.
     */
    imageId: integer("image_id"),
    /** Дублируется из deck_images ради прогресса в списке слайдов без join. */
    imageStatus: text("image_status").$type<ImageStatus>().notNull().default("none"),
    /** Описание схемы для тех слайдов, где нужна не метафора, а структура. */
    diagramSpec: jsonb("diagram_spec"),
  },
  (t) => ({
    byDeck: index("deck_slides_deck_idx").on(t.deckId, t.ord),
  }),
);

export type DeckImageStatus = "drawing" | "ready" | "rejected" | "error";

/**
 * Попытка нарисовать иллюстрацию к слайду. Отдельной таблицей, а не полями
 * слайда: попыток по правилу конвейера бывает две, и забракованную вместе с
 * вердиктом приёмки автор должен видеть — иначе «почему перерисовали» знает
 * только лог.
 */
export const deckImagesTable = pgTable(
  "deck_images",
  {
    id: serial("id").primaryKey(),
    deckId: integer("deck_id")
      .notNull()
      .references(() => decksTable.id, { onDelete: "cascade" }),
    slideId: integer("slide_id")
      .notNull()
      .references(() => deckSlidesTable.id, { onDelete: "cascade" }),
    /** Номер попытки, начиная с 1. Потолок — 2, дальше слайд идёт как есть. */
    attempt: integer("attempt").notNull().default(1),
    /** Сюжет метафоры, придуманный шагом режиссуры по мысли слайда. */
    scene: text("scene").notNull().default(""),
    /** Итоговый промпт: сюжет + стилевой пакет. Чтобы можно было повторить. */
    prompt: text("prompt").notNull().default(""),
    /** Какой моделью нарисовано — основной или запасной. */
    model: text("model").notNull().default(""),
    path: text("path"),
    status: text("status").$type<DeckImageStatus>().notNull().default("drawing"),
    /** Что сказала приёмка: почему приняли или отправили на перерисовку. */
    verdict: text("verdict"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySlide: index("deck_images_slide_idx").on(t.slideId, t.attempt),
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
export type DeckImage = typeof deckImagesTable.$inferSelect;
export type StylePack = typeof stylePacksTable.$inferSelect;
