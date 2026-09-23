import { failHttp } from "./http-fail";
import { logger } from "./logger";

/**
 * Векторы для поиска по смыслу — ЛОКАЛЬНО, на этом же сервере (kotu-embed,
 * multilingual-e5-large). Индексация библиотеки не покидает Россию вовсе:
 * за границу тексты уходят только позже, в промптах лекций (зона Б).
 *
 * Модель зафиксирована и НЕ должна меняться на живой библиотеке: векторы
 * разных моделей несопоставимы, после смены нужна полная переиндексация.
 */
const EMBED_URL = process.env["EMBED_URL"] ?? "http://127.0.0.1:9030/embed";

/** За раз отправляем пачку — модель на CPU, но пачкой всё равно быстрее. */
const BATCH = 32;

/**
 * У E5 префиксы обязательны и разные: фрагмент индексируется как «passage»,
 * а поисковый запрос — как «query». Перепутать — значит уронить качество.
 */
export type EmbedKind = "passage" | "query";

async function embedBatch(texts: string[], kind: EmbedKind): Promise<number[][]> {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts, kind }),
    // CPU неспешный: толстая пачка длинных фрагментов может считаться минуты.
    signal: AbortSignal.timeout(600_000),
  });

  if (!res.ok) return failHttp(res, "Эмбеддинги");

  const data = (await res.json()) as { vectors: number[][] };
  if (!Array.isArray(data.vectors) || data.vectors.length !== texts.length) {
    throw new Error("Эмбеддинги: сервис вернул не то число векторов");
  }
  return data.vectors;
}

/** Считает векторы для всех фрагментов, сообщая о продвижении. */
export async function embedAll(
  texts: string[],
  onProgress?: (done: number, total: number) => Promise<void> | void,
  kind: EmbedKind = "passage",
): Promise<number[][]> {
  const result: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const vectors = await embedBatch(slice, kind);
    result.push(...vectors);
    await onProgress?.(Math.min(i + BATCH, texts.length), texts.length);
    logger.debug({ done: result.length, total: texts.length }, "Эмбеддинги посчитаны");
  }
  return result;
}
