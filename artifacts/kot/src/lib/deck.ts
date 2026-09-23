import {
  SLIDE_LAYOUTS,
  LAYOUT_RU,
  FIELDS_BY_LAYOUT,
  type SlideContent,
  type DiagramSpec,
  type SlideField,
} from '@workspace/db/slides';
import type { DeckStatus, ImageSide, ImageStatus, DeckImageStatus } from '@workspace/db/schema';

/**
 * Форма презентации на фронте — общая для списка слайдов и для просмотра
 * слайда крупно. Вынесена из Slides.tsx, чтобы два экрана описывали колоду
 * одинаково, а не расходились по мере правок. Типы содержимого и статусов —
 * из схемы базы: руками их не дублируем. Здесь только форма JSON-ответа
 * (даты по сети приходят строками).
 */

export type { DeckStatus, SlideContent, DiagramSpec, SlideField };

export interface DeckSlide {
  id: number;
  ord: number;
  layout: string;
  content: SlideContent;
  notes: string;
  imageBrief: string | null;
  imageSide: ImageSide;
  imageId: number | null;
  imageStatus: ImageStatus;
  diagramSpec: DiagramSpec | null;
}

export interface DeckImage {
  id: number;
  slideId: number;
  attempt: number;
  status: DeckImageStatus;
  verdict: string | null;
}

export interface DeckFull {
  id: number;
  title: string;
  status: DeckStatus;
  statusMessage: string;
  error: string | null;
  stylePackId: number | null;
  /** Раскадровка утверждена — колода уже «готовая», даже пока правится слайд. */
  storyboardApproved: boolean;
  /** Цвета стилевого пакета — ими рисуется предпросмотр слайда. */
  palette: Record<string, string> | null;
  slides: DeckSlide[];
  images: DeckImage[];
}

/** Конвейер раскладывает или рисует — править и выгружать пока нельзя. */
export const deckWorking = (status: DeckStatus): boolean =>
  status === 'storyboarding' || status === 'drawing';

// Названия и порядок макетов — из общей таблицы: тот же список, по которому
// собираются PPTX и PDF. Иначе в браузере появлялся бы макет, которого нет
// в выгрузке (или наоборот).
export { LAYOUT_RU, layoutHasImage, layoutSided } from '@workspace/db/slides';
export const LAYOUTS: readonly string[] = SLIDE_LAYOUTS;

/**
 * Название макета для показа. Слайд приходит с сервера строкой, а таблица
 * знает ровно восемь макетов — незнакомый показываем как есть, вместо пустоты.
 */
export const layoutName = (layout: string): string =>
  (LAYOUT_RU as Record<string, string>)[layout] ?? layout;

/**
 * Какие поля осмысленны на макете — из общей таблицы, по которой переписывает
 * слайд и модель. Незнакомый макет — заголовок и тезисы, как у теории.
 */
export const fieldsOf = (layout: string): readonly SlideField[] =>
  (FIELDS_BY_LAYOUT as Record<string, readonly SlideField[]>)[layout] ?? ['title', 'bullets'];

export const FIELD_RU: Record<SlideField, string> = {
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

/**
 * Последний образ каждого слайда. Судьбу картинки решает последняя попытка,
 * и «последняя» — по id, а не по attempt: перерисовка начинает счёт попыток
 * заново с 1.
 */
export function lastImageBySlide(images: DeckImage[]): Map<number, DeckImage> {
  const last = new Map<number, DeckImage>();
  for (const im of images) {
    const prev = last.get(im.slideId);
    if (!prev || im.id > prev.id) last.set(im.slideId, im);
  }
  return last;
}
