/** Приписка к system-промпту, когда ответ нужен объектом. */
export const JSON_RULE = "Отвечай СТРОГО одним JSON-объектом, без пояснений и без markdown.";

/**
 * Разбор ответа модели как JSON. Модели любят обернуть объект в ```json или
 * добавить фразу до или после — срезаем обёртку и вынимаем сам объект.
 */
export function parseModelJson<T>(raw: string, who: string): T {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        // Сырой SyntaxError отсюда однажды доехал до экрана автора —
        // наружу уходит только человеческая формулировка.
      }
    }
    throw new Error(`${who} вернул ответ, который не удалось разобрать как JSON`);
  }
}
