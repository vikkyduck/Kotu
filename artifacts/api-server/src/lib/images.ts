import { geminiImage } from "./gemini";
import { failHttp } from "./http-fail";
import { logger } from "./logger";
import { OPENAI_API_KEY, OPENAI_BASE_URL } from "./openai";

/** Форматы, которые понимает и приёмка Anthropic, и PowerPoint. */
export type IllustrationMime = "image/png" | "image/jpeg" | "image/webp";

/** Результат отрисовки: кто нарисовал — пригодится при разборе качества. */
export interface RenderedIllustration {
  buffer: Buffer;
  provider: "gemini" | "openai";
  model: string;
  mime: IllustrationMime;
  /** Расширение файла под mime — приёмка сверяет заявленный тип с байтами. */
  ext: "png" | "jpg" | "webp";
}

/**
 * Формат определяем по магическим байтам, а не по обещаниям поставщика:
 * Gemini спокойно отдаёт JPEG там, где ждёшь PNG, а Anthropic сверяет
 * заявленный media type с содержимым и отклоняет несовпадение.
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
  // Неизвестный формат: считаем PNG — дальше честно упадёт приёмка, не запись.
  return { mime: "image/png", ext: "png" };
}

async function renderWithOpenAi(prompt: string): Promise<RenderedIllustration> {
  const model = process.env["MODEL_IMAGE_FALLBACK"] ?? "gpt-image-2";
  const res = await fetch(`${OPENAI_BASE_URL}/images/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      prompt,
      size: process.env["IMAGE_SIZE"] ?? "1536x864",
      n: 1,
    }),
    // Запасной поставщик заметно медленнее основного, потому таймаут щедрее.
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) return failHttp(res, "OpenAI");

  const data = (await res.json()) as { data?: { b64_json?: string }[] };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI не вернул изображение");
  const buffer = Buffer.from(b64, "base64");
  return { buffer, provider: "openai", model, ...sniffImage(buffer) };
}

/**
 * Рисует иллюстрацию: сначала Gemini, при любой ошибке — запасной OpenAI.
 * Фолбэк именно по ПОСТАВЩИКУ, а не по модели: у Gemini модели пропадали
 * целыми семействами, и запасная модель того же поставщика не спасла бы.
 */
export async function renderIllustration(prompt: string): Promise<RenderedIllustration> {
  const geminiModel = process.env["MODEL_IMAGE"] ?? "gemini-3.1-flash-image";
  try {
    const buffer = await geminiImage({ prompt, model: geminiModel });
    logger.info({ provider: "gemini", model: geminiModel }, "Иллюстрация нарисована");
    return { buffer, provider: "gemini", model: geminiModel, ...sniffImage(buffer) };
  } catch (err) {
    if ((process.env["IMAGE_FALLBACK_PROVIDER"] ?? "openai") !== "openai") throw err;
    logger.warn({ err }, "Gemini не нарисовал — переключаюсь на запасного поставщика");
  }

  const rendered = await renderWithOpenAi(prompt);
  logger.info({ provider: rendered.provider, model: rendered.model }, "Иллюстрация нарисована");
  return rendered;
}
