import { geminiImage } from "./gemini";
import { logger } from "./logger";

/** Результат отрисовки: кто нарисовал — пригодится при разборе качества. */
export interface RenderedIllustration {
  buffer: Buffer;
  provider: "gemini" | "openai";
  model: string;
}

const OPENAI_BASE_URL =
  process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "http://127.0.0.1:8444/v1";
const OPENAI_API_KEY = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "";

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

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI ответил ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { data?: { b64_json?: string }[] };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI не вернул изображение");
  return { buffer: Buffer.from(b64, "base64"), provider: "openai", model };
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
    return { buffer, provider: "gemini", model: geminiModel };
  } catch (err) {
    if ((process.env["IMAGE_FALLBACK_PROVIDER"] ?? "openai") !== "openai") throw err;
    logger.warn({ err }, "Gemini не нарисовал — переключаюсь на запасного поставщика");
  }

  const rendered = await renderWithOpenAi(prompt);
  logger.info({ provider: rendered.provider, model: rendered.model }, "Иллюстрация нарисована");
  return rendered;
}
