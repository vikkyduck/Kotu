import { readFile } from "node:fs/promises";

/**
 * Обращения к Claude через собственный транзит (см. ARCHITECTURE.md §5).
 * Прямых запросов к api.anthropic.com нет и быть не должно: из России они
 * не проходят, а весь зарубежный трафик обязан идти через дроплет.
 */
const BASE_URL = process.env["ANTHROPIC_BASE_URL"] ?? "http://127.0.0.1:8444/anthropic";
const API_KEY = process.env["ANTHROPIC_API_KEY"] ?? "";
const VERSION = "2023-06-01";

export interface ImageAttachment {
  path: string;
  mediaType: "image/png" | "image/jpeg";
}

interface AskOptions {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  /** Картинки, на которые Claude должен посмотреть. */
  images?: ImageAttachment[];
  timeoutMs?: number;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export function claudeConfigured(): boolean {
  return API_KEY !== "";
}

export async function ask(opts: AskOptions): Promise<string> {
  if (!claudeConfigured()) throw new Error("Claude не подключён: нет ANTHROPIC_API_KEY");

  const content: ContentBlock[] = [];
  for (const img of opts.images ?? []) {
    const data = await readFile(img.path);
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: data.toString("base64") },
    });
  }
  content.push({ type: "text", text: opts.user });

  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": VERSION,
    },
    body: JSON.stringify({
      model: opts.model ?? process.env["MODEL_DECK"] ?? "claude-opus-5",
      max_tokens: opts.maxTokens ?? 8000,
      system: opts.system,
      messages: [{ role: "user", content }],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude ответил ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

/**
 * Ответ строго объектом. Модели любят обернуть JSON в ```json — срезаем,
 * иначе разбор падает на ровном месте.
 */
export async function askJson<T>(opts: AskOptions): Promise<T> {
  const raw = await ask({
    ...opts,
    system: `${opts.system}\n\nОтвечай СТРОГО одним JSON-объектом, без пояснений и без markdown.`,
  });

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Иногда модель добавляет фразу до или после — вынимаем сам объект.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new Error("Claude вернул ответ, который не удалось разобрать как JSON");
  }
}
