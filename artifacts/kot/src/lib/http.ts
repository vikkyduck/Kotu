/**
 * Общее для всех запросов к API: как достать понятную фразу из ответа и что
 * сказать, когда сети нет. Раньше каждый экран разбирал ответ сам — копии
 * разошлись, и часть экранов показывала «Не удалось…» вместо причины, которую
 * сервер уже написал по-русски (503 «только чтение», 409 «ещё работаю»).
 */

export const OFFLINE = 'Нет связи с сервером. Попробуйте ещё раз.';

/** Причина отказа из тела ответа: сервер пишет её в message. */
export async function failText(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
  const text = body?.message;
  return typeof text === 'string' && text.trim() ? text : fallback;
}

/**
 * Запрос, после которого экрану нужно одно: получилось или какой текст
 * показать. Сеть упала — OFFLINE; сервер отказал — его фраза или fallback.
 */
export async function send(
  url: string,
  init: RequestInit | undefined,
  fallback: string,
): Promise<{ ok: true; res: Response } | { ok: false; message: string }> {
  try {
    const res = await fetch(url, init);
    if (res.ok) return { ok: true, res };
    return { ok: false, message: await failText(res, fallback) };
  } catch {
    return { ok: false, message: OFFLINE };
  }
}

/** Тело запроса в JSON — чтобы не повторять заголовок в каждом вызове. */
export function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * Скачивание выгрузки (Word, PDF, PPTX) через fetch, а не простой ссылкой:
 * при отказе сервера ссылка открыла бы сырой JSON вместо приложения.
 * Возвращает null при успехе или текст ошибки для тоста.
 */
export async function downloadFile(url: string, fallbackName: string): Promise<string | null> {
  const r = await send(url, undefined, 'Не удалось скачать файл');
  if (!r.ok) return r.message;
  const blob = await r.res.blob();
  const cd = r.res.headers.get('Content-Disposition') ?? '';
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  saveBlob(blob, star ? decodeURIComponent(star) : fallbackName);
  return null;
}

/**
 * Отдать файл браузеру на сохранение. Ссылка в документе и отзыв с
 * задержкой: немедленный revoke в Safari срывает скачивание.
 */
export function saveBlob(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
