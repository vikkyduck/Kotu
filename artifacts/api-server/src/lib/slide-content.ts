import type { SlideContent } from "@workspace/db";
import {
  FIELDS_BY_LAYOUT,
  MAX_CARDS,
  type SlideField,
  type SlideLayout,
} from "@workspace/db/slides";

/**
 * Приводит содержимое слайда к строгой форме. Источника у content два —
 * ответ модели и PATCH от автора, и оба на слово не верим: кривое поле
 * (число вместо строки, строка вместо массива) валит экспорт PPTX на
 * ровном месте. Лишние ключи отбрасываются, длины ограничены разумным.
 */
const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined;

export function sanitizeSlideContent(raw: unknown): SlideContent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: SlideContent = {};

  const eyebrow = str(r["eyebrow"], 200);
  const title = str(r["title"], 300);
  const subtitle = str(r["subtitle"], 500);
  const quote = str(r["quote"], 600);
  const attribution = str(r["attribution"], 200);
  const question = str(r["question"], 400);
  const plate = str(r["plate"], 120);
  if (eyebrow) out.eyebrow = eyebrow;
  if (title) out.title = title;
  if (subtitle) out.subtitle = subtitle;
  if (quote) out.quote = quote;
  if (attribution) out.attribution = attribution;
  if (question) out.question = question;
  if (plate) out.plate = plate;

  if (Array.isArray(r["bullets"])) {
    const bullets = r["bullets"]
      .map((b) => str(b, 300))
      .filter((b): b is string => b !== undefined)
      .slice(0, 12);
    if (bullets.length > 0) out.bullets = bullets;
  }

  if (Array.isArray(r["cards"])) {
    const cards = r["cards"]
      .map((c) => {
        if (!c || typeof c !== "object") return undefined;
        const card = c as Record<string, unknown>;
        const cardTitle = str(card["title"], 200);
        const body = str(card["body"], 600);
        if (!cardTitle && !body) return undefined;
        return { title: cardTitle ?? "", body: body ?? "" };
      })
      .filter((c): c is { title: string; body: string } => c !== undefined)
      // Сверх двух колонок лист не рисует и форма не правит — в базе они
      // лежали бы невидимыми и пропадали при первом сохранении из формы.
      .slice(0, MAX_CARDS);
    if (cards.length > 0) out.cards = cards;
  }

  return out;
}

/**
 * Модель иногда кладёт текст не в то поле макета: цитату — в title, абзац
 * случая — в subtitle, вывод финала — в quote. На слайде видны только поля
 * макета (FIELDS_BY_LAYOUT), поэтому такой текст переносим в поле макета
 * сразу при записи ответа — иначе он лежал бы невидимым и неправимым.
 * Исходное поле не трогаем: при смене макета оно вернётся на своё место.
 */
export function settleContent(layout: SlideLayout, c: SlideContent): SlideContent {
  if (layout === "quote" && !c.quote && c.title) return { ...c, quote: c.title };
  if (layout === "clinical" && !c.bullets && c.subtitle) return { ...c, bullets: [c.subtitle] };
  if (layout === "final" && !c.title && c.quote) return { ...c, title: c.quote };
  return c;
}

/**
 * То же при чтении: слайды, записанные раньше settleContent, показывают свой
 * текст в поле макета — на экране, в форме и в файлах. В базу он ляжет с
 * первым сохранением слайда; сама система ничего не перезаписывает.
 */
export function settleSlides<T extends { layout: SlideLayout; content: SlideContent | null }>(
  slides: T[],
): T[] {
  return slides.map((s) => ({ ...s, content: settleContent(s.layout, s.content ?? {}) }));
}

/**
 * Подсказки модели к полям — сами поля берутся из общей таблицы
 * FIELDS_BY_LAYOUT, по которой автор правит слайд руками.
 */
const HINTS: Partial<Record<SlideLayout, Partial<Record<SlideField, string>>>> = {
  theory: { bullets: "3–5 коротких" },
  quote: { quote: "до 35 слов" },
  clinical: { bullets: "абзацы фрагмента" },
  comparison: { cards: "ровно две карточки {title, body}" },
};

/** Какие поля осмысленны на макете — строкой для промпта раскадровки и переделки. */
export function fieldsLine(layout: SlideLayout): string {
  return FIELDS_BY_LAYOUT[layout]
    .map((f) => {
      const name = f === "bullets" || f === "cards" ? `${f}[]` : f;
      const hint = HINTS[layout]?.[f];
      return hint ? `${name} (${hint})` : name;
    })
    .join(", ");
}
