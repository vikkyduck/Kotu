/**
 * Номер записи из адреса (/lectures/:id и т. п.). Одно правило для всех
 * ручек: не целое положительное число — null, и ручка отвечает 404, как на
 * чужую или удалённую запись. Раньше было четыре варианта: где-то 400, где-то
 * 404, а в лекциях NaN уходил прямо в Postgres и возвращался 500.
 */
export function parseId(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
