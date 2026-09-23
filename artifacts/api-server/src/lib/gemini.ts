import { failHttp } from "./http-fail";
import { JSON_RULE, parseModelJson } from "./model-json";

/**
 * Обращения к Gemini через собственный транзит (см. ARCHITECTURE.md §5) —
 * как и с Claude, из России напрямую запросы не проходят, весь зарубежный
 * трафик идёт через дроплет.
 */
const BASE_URL = process.env["GEMINI_BASE_URL"] ?? "http://127.0.0.1:8444/gemini";
const API_KEY = process.env["GEMINI_API_KEY"] ?? "";
const TIMEOUT_MS = 120_000;

interface TextOptions {
  system?: string;
  user: string;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
}

function geminiConfigured(): boolean {
  return API_KEY !== "";
}

async function generate(model: string, body: Record<string, unknown>): Promise<GeminiResponse> {
  if (!geminiConfigured()) throw new Error("Gemini не подключён: нет GEMINI_API_KEY");

  const res = await fetch(`${BASE_URL}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": API_KEY,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) return failHttp(res, "Gemini");

  return (await res.json()) as GeminiResponse;
}

async function geminiText(opts: TextOptions): Promise<string> {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: opts.user }] }],
  };
  // Пустую system_instruction Gemini считает ошибкой запроса — шлём только при наличии.
  if (opts.system) body["system_instruction"] = { parts: [{ text: opts.system }] };

  const data = await generate(process.env["MODEL_SCENE"] ?? "gemini-3.1-pro-preview", body);

  return (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

/** Ответ строго объектом — разбор в lib/model-json.ts. */
export async function geminiJson<T>(opts: TextOptions): Promise<T> {
  const raw = await geminiText({
    ...opts,
    system: opts.system ? `${opts.system}\n\n${JSON_RULE}` : JSON_RULE,
  });
  return parseModelJson<T>(raw, "Gemini");
}

export async function geminiImage(opts: { prompt: string; model: string }): Promise<Buffer> {
  const data = await generate(opts.model, {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  });

  // Модель вправе вернуть текст рядом с картинкой — ищем именно inlineData.
  const part = (data.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
  const b64 = part?.inlineData?.data;
  if (!b64) throw new Error("Gemini не вернул изображение");
  return Buffer.from(b64, "base64");
}
