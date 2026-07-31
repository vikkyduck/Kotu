import type { SlideContent } from "@workspace/db";

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
      .slice(0, 4);
    if (cards.length > 0) out.cards = cards;
  }

  return out;
}
