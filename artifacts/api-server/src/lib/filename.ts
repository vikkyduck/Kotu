/**
 * Чинит русские имена загружаемых файлов.
 *
 * Разбор multipart отдаёт имя файла, прочитанное как latin1 — таков умолчательный
 * режим busboy. Для «report.pdf» разницы нет, а «Бриф по встрече.mp4» превращается
 * в «ÐÑÐ¸Ñ Ð¿Ð¾ Ð²ÑÑÑÐµÑÐµ.mp4», и это уезжает в базу и на экран.
 *
 * Перекодируем обратно, но осторожно: если байты не складываются в осмысленный
 * UTF-8 (браузер прислал имя правильно), оставляем как было.
 */
const HAS_HIGH_BYTES = /[\u0080-\u00ff]/;
const REPLACEMENT_CHAR = "\ufffd";

export function decodeUploadName(name: string): string {
  if (!name) return name;
  // Чистое ASCII-имя испортиться не могло — не трогаем.
  if (!HAS_HIGH_BYTES.test(name)) return name;

  const restored = Buffer.from(name, "latin1").toString("utf8");
  return restored.includes(REPLACEMENT_CHAR) ? name : restored;
}

/**
 * Заголовок Content-Disposition для выгрузки. Одно правило для лекций и
 * презентаций: имя очищено от знаков, ломающих заголовок (апостроф, скобки),
 * обрезано до 60 знаков, плюс ASCII-запасное имя для старых клиентов.
 */
export function attachmentHeader(title: string, ext: string, fallback: string): string {
  const safe = title.replace(/[^\p{L}\p{N} .-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  const name = `${safe || fallback}.${ext}`;
  return `attachment; filename="download.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
