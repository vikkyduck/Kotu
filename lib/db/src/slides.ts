/**
 * Устройство слайда — единственное место, где живут его макеты и размеры.
 *
 * По этим числам рисуют три разных движка: выгрузка в PowerPoint, выгрузка
 * в PDF и предпросмотр слайда в браузере. Раньше у каждого была своя копия
 * чисел, и они уже успели разойтись — в предпросмотре шаги схемы набирались
 * 17-м кеглем, а в готовом файле 20-м. Автор правит слайд, глядя на одно,
 * и получает другое.
 *
 * Числа даны для листа 16:9 шириной 960 пунктов (13,333 дюйма — размер
 * страницы PowerPoint). Каждый движок переводит их в свои единицы:
 * PPTX — в дюймы (пункты ÷ 72), PDF берёт пункты как есть, предпросмотр —
 * в доли ширины (пункты ÷ 960 × 100).
 *
 * Файл нарочно без зависимостей: его читает и сервер, и браузер.
 */

/**
 * Семь функций слайда из брендбука Psy3107 («Архивный сон», `brand/`) плюс
 * `diagram` — наше расширение для структуры, которую рисуем кодом.
 *
 * Порядок работы задан брендбуком: сначала определяется ФУНКЦИЯ слайда,
 * и только из неё следует композиция. Поэтому список — не набор вёрсток
 * («две карточки», «картинка во всю»), а набор задач.
 */
export const SLIDE_LAYOUTS = [
  "cover", // обложка: текст слева, образ справа
  "divider", // разделитель: короткое имя части, много спокойного поля
  "theory", // теория: тезис и 3–5 пунктов, одна крупная гравюра
  "quote", // цитата до 35 слов, образ на противоположном краю
  "clinical", // клинический фрагмент: интерьер или объект, не портрет
  "comparison", // сравнение: одна гравюра со швом, два столбца текста
  "final", // финал: вывод, без «спасибо за внимание»
  "diagram", // структура: рисуется кодом, но оформлена как лист атласа
] as const;

export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

/** Названия макетов по-русски — для экранов, где автор выбирает функцию. */
export const LAYOUT_RU: Record<SlideLayout, string> = {
  cover: "Обложка",
  divider: "Разделитель",
  theory: "Теория",
  quote: "Цитата",
  clinical: "Клинический фрагмент",
  comparison: "Сопоставление",
  final: "Финал",
  diagram: "Схема",
};

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

/** Все поля содержимого — для перебора там, где форма собирает content. */
export const SLIDE_FIELDS = [
  "eyebrow",
  "title",
  "subtitle",
  "bullets",
  "cards",
  "quote",
  "attribution",
  "question",
  "plate",
] as const satisfies readonly (keyof SlideContent)[];

export type SlideField = (typeof SLIDE_FIELDS)[number];

/**
 * Какие поля осмысленны на каком макете. По этой таблице автор правит слайд
 * руками, и по ней же модель переписывает его словами (lib/handlers/reslide.ts):
 * автор видит ровно то, что попадёт на слайд. Новый макет без строки здесь
 * не соберётся.
 */
export const FIELDS_BY_LAYOUT: Record<SlideLayout, readonly SlideField[]> = {
  cover: ["eyebrow", "title", "subtitle"],
  divider: ["eyebrow", "title"],
  theory: ["title", "bullets", "question", "plate"],
  quote: ["quote", "attribution"],
  clinical: ["title", "bullets", "question"],
  comparison: ["title", "cards"],
  final: ["title", "subtitle"],
  diagram: ["title"],
};

/** Колонок у сопоставления — две: столько рисуют все три движка и правит форма. */
export const MAX_CARDS = 2;

/**
 * Схема diagram-слайда, которую рисует код, а не художник: flow — шаги со
 * стрелками сверху вниз, pillars — колонки рядом. 2..SLIDE_SPEC.diagram.maxItems
 * элементов, label ≤60 знаков, sub ≤120 — пределы держит разбор раскадровки.
 */
export type DiagramSpec = {
  kind: "flow" | "pillars";
  items: { label: string; sub?: string }[];
};

/**
 * Где у макета образ. Сторону (слева/справа) слушают только эти три —
 * обложка и разделитель ставят образ справа, сопоставление — полосой сверху.
 */
const SIDED_LAYOUTS: readonly string[] = ["theory", "quote", "clinical"];
/** Макеты без образа: финал выводит только текст, схему рисует код. */
const NO_IMAGE_LAYOUTS: readonly string[] = ["final", "diagram"];

/** Бывает ли у макета образ — иначе картинку оплатили бы и нигде не показали. */
export const layoutHasImage = (layout: string): boolean => !NO_IMAGE_LAYOUTS.includes(layout);

/** Слушает ли макет сторону образа. */
export const layoutSided = (layout: string): boolean => SIDED_LAYOUTS.includes(layout);

/**
 * Палитра брендбука «Архивный сон» (раздел 2). Живая палитра приходит из
 * стилевого пакета; эта — на случай, когда пакет её не задал, и её же пишет
 * сид пакета.
 */
export const BRAND_PALETTE = {
  archiveBlack: "#1D1E24",
  deepIndigo: "#232638",
  charcoal: "#2B292B",
  agedPaper: "#D8C7A7",
  deepSepia: "#C4AD87",
  etchingInk: "#302B27",
  burntUmber: "#7B432F",
  museumIndigo: "#677184",
  driedCarmine: "#955A52",
  dullGold: "#B08D57",
} as const;

export type BrandColor = keyof typeof BRAND_PALETTE;

/** Цвет листа: из палитры стилевого пакета, не задан — из брендбука. */
export const slideColor = (
  palette: Record<string, string> | null | undefined,
  name: BrandColor,
): string => palette?.[name] ?? BRAND_PALETTE[name];

/**
 * Цвет букв на слайде. Один на всю колоду и чисто белый: тёплые бежевые
 * и сепия читались на тёмном как приглушённые, а умбра и музейный индиго
 * не дотягивали до нормы контраста (4.3 и 3.4 при норме 4.5).
 */
export const SLIDE_TEXT = "#FFFFFF";
/** Шов между колонками сравнения — волосяная линия старой сшивки. */
export const SLIDE_SEAM = "#65594E";

/** Лист 16:9 в пунктах — система координат всех чисел ниже. */
export const SHEET = { width: 960, height: 540 } as const;

/** Кегли в пунктах. Имя поля говорит, что именно набирается. */
export const SLIDE_TYPE = {
  coverEyebrow: 12,
  coverTitle: 36,
  coverSubtitle: 16,
  dividerEyebrow: 13,
  dividerTitle: 40,
  theoryTitle: 28,
  bullets: 19,
  /** «Рабочий вопрос» — приём брендбука на теории и клиническом фрагменте. */
  question: 16,
  /** Музейная подпись под образом: «PLATE V · PSYCHIC ATLAS». */
  plate: 11,
  quote: 28,
  attribution: 13,
  clinicalTitle: 23,
  clinicalBody: 18,
  comparisonTitle: 25,
  cardTitle: 18,
  cardBody: 16,
  finalTitle: 30,
  finalSubtitle: 16,
  diagramTitle: 28,
  nodeLabel: 17,
  nodeSub: 12,
  /** Арабский номер листа внизу обложки и финала. */
  folio: 11,
} as const;

/**
 * Межстрочный — множитель к собственной высоте строки шрифта: так его
 * понимают и PowerPoint (lineSpacingMultiple), и PDF (lineGap). Имя поля
 * говорит, что набирается; plain — всё, что идёт одинарным.
 */
export const SLIDE_LEADING = {
  /** Заголовки обложки, разделителя, теории и схемы. */
  title: 1.05,
  bullets: 1.1,
  /** Абзацы клинического фрагмента и текст колонок сравнения. */
  body: 1.15,
  quote: 1.15,
  final: 1.1,
  /** Расшифровка шага или опоры схемы. */
  nodeSub: 1.2,
  plain: 1,
} as const;

/**
 * Собственная высота строки Manrope в кеглях: (ascent + |descent|) / upm
 * из таблицы hhea шрифта, (2132 + 600) / 2000. CSS считает line-height от
 * кегля, а не от этой высоты, — предпросмотр умножает SLIDE_LEADING на неё,
 * иначе набирался бы заметно плотнее файла.
 */
export const FONT_LINE = 1.366;

/** Композиция: сколько места занимает образ и где проходят поля. */
export const SLIDE_SPEC = {
  /** Музейное поле по краям листа, пункты (0,85 дюйма). */
  margin: 61.2,
  /**
   * Доля ширины листа под образ. Противоположная сторона — спокойное поле
   * под типографику, брендбук требует не меньше 35% ширины.
   */
  imageShare: {
    cover: 0.58,
    divider: 0.3,
    theory: 0.45,
    quote: 0.4,
    clinical: 0.4,
  },
  /** У сопоставления образ идёт полосой сверху — это доля ВЫСОТЫ листа. */
  comparisonBand: 0.38,
  diagram: {
    /** Больше четырёх опор в строку листа не встаёт; шагов раскадровка даёт столько же. */
    maxItems: 4,
  },
} as const;
