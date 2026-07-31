import { SLIDE_LAYOUTS, LAYOUT_RU } from '@workspace/db/slides';

/**
 * Форма презентации на фронте — общая для списка слайдов и для просмотра
 * слайда крупно. Вынесена из Slides.tsx, чтобы два экрана описывали колоду
 * одинаково, а не расходились по мере правок.
 */

export type DeckStatus = 'storyboarding' | 'storyboard_ready' | 'drawing' | 'ready' | 'error';

export interface SlideContent {
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  bullets?: string[];
  cards?: { title: string; body: string }[];
  quote?: string;
  attribution?: string;
  question?: string;
  plate?: string;
}

/** Схема diagram-слайда, которую рисует код (контракт — lib/db, DiagramSpec). */
export interface DiagramSpec {
  kind: 'flow' | 'pillars';
  items: { label: string; sub?: string }[];
}

export interface DeckSlide {
  id: number;
  ord: number;
  layout: string;
  content: SlideContent;
  notes: string;
  imageBrief: string | null;
  imageSide: 'left' | 'right';
  imageId: number | null;
  imageStatus: 'none' | 'queued' | 'drawing' | 'ready' | 'error';
  diagramSpec: DiagramSpec | null;
}

export interface DeckImage {
  id: number;
  slideId: number;
  attempt: number;
  status: 'drawing' | 'ready' | 'rejected' | 'error';
  verdict: string | null;
}

export interface DeckFull {
  id: number;
  title: string;
  status: DeckStatus;
  statusMessage: string;
  error: string | null;
  stylePackId: number | null;
  /** Цвета стилевого пакета — ими рисуется предпросмотр слайда. */
  palette: Record<string, string> | null;
  slides: DeckSlide[];
  images: DeckImage[];
}

// Названия и порядок макетов — из общей таблицы: тот же список, по которому
// собираются PPTX и PDF. Иначе в браузере появлялся бы макет, которого нет
// в выгрузке (или наоборот).
export { LAYOUT_RU } from '@workspace/db/slides';
export const LAYOUTS: readonly string[] = SLIDE_LAYOUTS;

/**
 * Название макета для показа. Слайд приходит с сервера строкой, а таблица
 * знает ровно восемь макетов — незнакомый показываем как есть, вместо пустоты.
 */
export const layoutName = (layout: string): string =>
  (LAYOUT_RU as Record<string, string>)[layout] ?? layout;

/**
 * Какие поля осмысленны на каком макете. Тот же список, что у модели в
 * lib/handlers/reslide.ts: автор правит ровно то, что попадёт на слайд,
 * и не видит полей, которые этот макет всё равно не покажет.
 */
export const FIELDS_BY_LAYOUT: Record<string, string[]> = {
  cover: ['eyebrow', 'title', 'subtitle'],
  divider: ['eyebrow', 'title'],
  theory: ['title', 'bullets', 'question', 'plate'],
  quote: ['quote', 'attribution'],
  clinical: ['title', 'bullets', 'question'],
  comparison: ['title', 'cards'],
  final: ['title', 'subtitle'],
  diagram: ['title'],
};

export const FIELD_RU: Record<string, string> = {
  eyebrow: 'Надзаголовок',
  title: 'Заголовок',
  subtitle: 'Подзаголовок',
  bullets: 'Тезисы — по одному в строке',
  cards: 'Две колонки',
  quote: 'Цитата',
  attribution: 'Кто сказал',
  question: 'Рабочий вопрос',
  plate: 'Музейная подпись под образом',
};
