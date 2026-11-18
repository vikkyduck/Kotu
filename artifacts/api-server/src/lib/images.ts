import { drawImage, type ImageMime, type Route } from "./codex";
import { logger } from "./logger";

/** Форматы, которые понимают и приемка, и PowerPoint. */
export type IllustrationMime = ImageMime;

/** Результат отрисовки: каким путем нарисовано - пригодится при разборе качества и расходов. */
export interface RenderedIllustration {
  buffer: Buffer;
  /** codex - по подписке, api - по запасному ключу. */
  provider: Route;
  model: string;
  mime: IllustrationMime;
  /** Расширение файла под mime - приемка сверяет заявленный тип с байтами. */
  ext: "png" | "jpg" | "webp";
}

/**
 * Формат определяем по магическим байтам, а не по обещаниям поставщика:
 * поставщик может отдать JPEG там, где ждешь PNG, а приемка сверяет
 * заявленный тип с содержимым.
 */
export function sniffImage(buffer: Buffer): { mime: IllustrationMime; ext: "png" | "jpg" | "webp" } {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e) {
    return { mime: "image/png", ext: "png" };
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    buffer.length > 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  // Неизвестный формат: считаем PNG - дальше честно упадет приемка, не запись.
  return { mime: "image/png", ext: "png" };
}

/**
 * Рисует иллюстрацию через Codex (gpt-image-2 по подписке). Если подписка
 * недоступна, lib/codex.ts сам переходит на запасной ключ API и сообщает
 * об этом владелице.
 */
export async function renderIllustration(prompt: string): Promise<RenderedIllustration> {
  const drawn = await drawImage(prompt);
  logger.info({ provider: drawn.route, model: drawn.model }, "Иллюстрация нарисована");
  return { buffer: drawn.buffer, provider: drawn.route, model: drawn.model, ...sniffImage(drawn.buffer) };
}
