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

/**
 * Семь функций слайда из брендбука Psy3107 («Архивный сон», `brand/`) плюс
 * `diagram` — наше расширение для структуры, которую рисуем кодом.
 *
 * Порядок работы задан брендбуком: сначала определяется ФУНКЦИЯ слайда,
 * и только из неё следует композиция. Поэтому список — не набор вёрсток
 * («две карточки», «картинка во всю»), а набор задач.
 */
export type SlideLayout =
  | "cover" // обложка: текст слева 42%, образ справа 58%
  | "divider" // разделитель: короткое имя части, 60–70% спокойного поля
  | "theory" // теория: тезис и 3–5 пунктов, одна крупная гравюра
  | "quote" // цитата до 35 слов, образ на противоположном краю
  | "clinical" // клинический фрагмент: интерьер или объект, не портрет
  | "comparison" // сравнение: одна гравюра со швом, два столбца текста
  | "final" // финал: вывод, один спокойный объект, без «спасибо за внимание»
  | "diagram"; // структура: SVG кодом, но оформленный как лист атласа

/** Содержимое слайда. Поля необязательные: у каждого макета свои. */
export interface SlideContent {
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  bullets?: string[];
  cards?: { title: string; body: string }[];
  quote?: string;
  attribution?: string;
  /**
   * «Рабочий вопрос» / «вопрос к материалу» — приём брендбука на слайдах
   * теории и клинического фрагмента: слайд заканчивается не выводом,
   * а вопросом к слушателю.
   */
  question?: string;
  /** Музейная подпись под изображением: «PLATE V · PSYCHIC ATLAS». */
  plate?: string;
}

/**
 * На какой стороне слайда стоит образ. Противоположная сторона — safe zone
 * под типографику (брендбук: не меньше 35% ширины). Хранится на слайде,
 * потому что уходит прямо в промпт: модель должна оставить поле пустым,
 * дорисовать его потом нельзя.
 */
export type ImageSide = "left" | "right";

/**
 * Схема diagram-слайда, которую рисует код, а не художник: flow — шаги со
 * стрелками сверху вниз, pillars — колонки рядом. 2..6 элементов,
 * label ≤60 знаков, sub ≤120 — пределы держит разбор раскадровки.
 */
export type DiagramSpec = {
  kind: "flow" | "pillars";
  items: { label: string; sub?: string }[];
};

export const decksTable = pgTable("decks", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  /** Папка библиотеки — см. комментарий у лекций: библиотека главная папка. */
  folderId: integer("folder_id"),
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
    layout: text("layout").$type<SlideLayout>().notNull().default("theory"),
    content: jsonb("content").$type<SlideContent>().notNull(),
    /** Заметки докладчику — то, что говорят, а не показывают. */
    notes: text("notes").notNull().default(""),
    /**
     * Мысль, которую должна нести иллюстрация. Пишет Claude — он отвечает за
     * содержание. Сюжет по этой мысли придумывает уже Gemini отдельным шагом.
     */
    imageBrief: text("image_brief"),
    /** Сторона образа; safe zone под текст — на противоположной. */
    imageSide: text("image_side").$type<ImageSide>().notNull().default("right"),
    /**
     * Выбранная картинка из deck_images. Внешнего ключа нет намеренно: ссылка
     * идёт в обе стороны, и FK замкнул бы таблицы в цикл.
     */
    imageId: integer("image_id"),
    /** Дублируется из deck_images ради прогресса в списке слайдов без join. */
    imageStatus: text("image_status").$type<ImageStatus>().notNull().default("none"),
    /** Описание схемы для тех слайдов, где нужна не метафора, а структура. */
    diagramSpec: jsonb("diagram_spec").$type<DiagramSpec | null>(),
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
    /**
     * Кто рисовал. Поставщиков два: основной Gemini и запасной OpenAI —
     * когда картинки пойдут разного качества, надо знать, чьи именно.
     */
    provider: text("provider").$type<"gemini" | "openai">().notNull().default("gemini"),
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

/** Именованные цвета брендбука: имя → #hex. */
export type Palette = Record<string, string>;

/** Шрифты и кегли. Кегли даны для 16:9 и уезжают в вёрстку слайда. */
export interface Typography {
  display: string;
  body: string;
  displayFallback: string;
  bodyFallback: string;
  sizes: Record<string, [number, number] | number>;
}

/** Числовые правила композиции — их проверяет вёрстка, а не глаз. */
export interface StyleRules {
  aspect: string;
  /** Размер картинки у модели. Обе стороны обязаны быть кратны 16. */
  imageSize: string;
  imageSharePct: [number, number];
  safeZonePct: [number, number];
  maxBodyLines: number;
  /** Метафорические системы; в одном образе их разрешено не больше двух. */
  metaphorFamilies: string[];
  maxMetaphorsPerImage: number;
}

/**
 * Визуальный язык серии. Жёсткая часть промпта живёт здесь, а не в коде:
 * стиль — вопрос вкуса автора, его меняют без правки приложения.
 * Первый пакет — «Архивный сон» из брендбука Psy3107 (`brand/`).
 */
export const stylePacksTable = pgTable("style_packs", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id").references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Мастер-промпт: техника, палитра, настроение. Меняется только сюжет. */
  promptSuffix: text("prompt_suffix").notNull(),
  negative: text("negative").notNull().default(""),
  palette: jsonb("palette").$type<Palette>().notNull().default({}),
  typography: jsonb("typography").$type<Typography | null>(),
  rules: jsonb("rules").$type<StyleRules | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Deck = typeof decksTable.$inferSelect;
export type DeckSlide = typeof deckSlidesTable.$inferSelect;
export type DeckImage = typeof deckImagesTable.$inferSelect;
export type StylePack = typeof stylePacksTable.$inferSelect;
