import { readFile } from "node:fs/promises";
import { failHttp } from "./http-fail";
import { JSON_RULE, parseModelJson } from "./model-json";

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
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}

interface AskOptions {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  /** Картинки, на которые Claude должен посмотреть. */
  images?: ImageAttachment[];
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export function claudeConfigured(): boolean {
  return API_KEY !== "";
}

/** Событие SSE-потока — берём только то, что нужно для сборки текста. */
interface StreamEvent {
  type: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  error?: { message?: string };
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
    // Поток, а не разовый ответ: длинная раскадровка (до 50 слайдов)
    // генерируется дольше десяти минут, и нестриминговый запрос такой
    // длины обрывается по таймаутам — у API и у прокси по дороге.
    body: JSON.stringify({
      model: opts.model ?? process.env["MODEL_DECK"] ?? "claude-opus-5",
      max_tokens: opts.maxTokens ?? 8000,
      stream: true,
      system: opts.system,
      messages: [{ role: "user", content }],
    }),
    signal: AbortSignal.timeout(1_500_000),
  });

  if (!res.ok || !res.body) return failHttp(res, "Claude");

  // Разбор SSE руками: событие — блок строк до пустой строки, полезная
  // нагрузка в строках «data: {...}». Куски приходят как попало, поэтому
  // копим буфер и режем только по границам событий.
  let text = "";
  let stopReason = "";
  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        let ev: StreamEvent;
        try {
          ev = JSON.parse(line.slice(5).trim()) as StreamEvent;
        } catch {
          continue; // служебный мусор потока текстом не является
        }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          text += ev.delta.text ?? "";
        } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
          stopReason = ev.delta.stop_reason;
        } else if (ev.type === "error") {
          throw new Error(`Claude прервал поток: ${ev.error?.message ?? "без объяснения"}`);
        }
      }
    }
  }

  // Оборванный на потолке ответ — не ответ: дальше он падал бы загадочным
  // «Expected ',' or '}'» из разбора JSON. Честная ошибка вместо обломка.
  if (stopReason === "max_tokens") {
    throw new Error(
      "Ответ модели упёрся в потолок длины и оборвался — материал слишком объёмный для одного захода",
    );
  }
  return text.trim();
}

/** Ответ строго объектом — разбор в lib/model-json.ts. */
export async function askJson<T>(opts: AskOptions): Promise<T> {
  const raw = await ask({ ...opts, system: `${opts.system}\n\n${JSON_RULE}` });
  return parseModelJson<T>(raw, "Claude");
}
