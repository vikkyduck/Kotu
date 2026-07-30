import { logger } from "./logger";

/**
 * Векторы для поиска по смыслу. Идут через тот же транзит, что и остальные
 * модели (зона Б: книги и статьи — не персональные данные).
 *
 * Модель зафиксирована в конфигурации и НЕ должна меняться на живой библиотеке:
 * векторы разных моделей несопоставимы, после смены нужна полная переиндексация.
 */
const MODEL = process.env["MODEL_EMBEDDING"] ?? "text-embedding-3-small";
const BASE_URL = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "http://127.0.0.1:8444/v1";
const API_KEY = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "";

/** За раз отправляем пачку — так дешевле и быстрее, чем по одному фрагменту. */
const BATCH = 64;

export const EMBEDDING_DIMENSIONS = 1536;

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, input: texts }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Эмбеддинги: ответ ${res.status} ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { data: { index: number; embedding: number[] }[] };
  // Порядок в ответе формально не гарантирован — раскладываем по index.
  const out: number[][] = new Array(texts.length);
  for (const item of data.data) out[item.index] = item.embedding;
  return out;
}

/** Считает векторы для всех фрагментов, сообщая о продвижении. */
export async function embedAll(
  texts: string[],
  onProgress?: (done: number, total: number) => Promise<void> | void,
): Promise<number[][]> {
  const result: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const vectors = await embedBatch(slice);
    result.push(...vectors);
    await onProgress?.(Math.min(i + BATCH, texts.length), texts.length);
    logger.debug({ done: result.length, total: texts.length }, "Эмбеддинги посчитаны");
  }
  return result;
}
