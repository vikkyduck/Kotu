/**
 * Обращения к Gemini через собственный транзит (см. ARCHITECTURE.md §5) —
 * как и с Claude, из России напрямую запросы не проходят, весь зарубежный
 * трафик идёт через дроплет.
 */
const BASE_URL = process.env["GEMINI_BASE_URL"] ?? "http://127.0.0.1:8444/gemini";
const API_KEY = process.env["GEMINI_API_KEY"] ?? "";

interface TextOptions {
  system?: string;
  user: string;
  model?: string;
  timeoutMs?: number;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
}

export function geminiConfigured(): boolean {
  return API_KEY !== "";
}

async function generate(
  model: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<GeminiResponse> {
  if (!geminiConfigured()) throw new Error("Gemini не подключён: нет GEMINI_API_KEY");

  const res = await fetch(`${BASE_URL}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": API_KEY,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini ответил ${res.status}: ${text.slice(0, 200)}`);
  }

  return (await res.json()) as GeminiResponse;
}

export async function geminiText(opts: TextOptions): Promise<string> {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: opts.user }] }],
  };
  // Пустую system_instruction Gemini считает ошибкой запроса — шлём только при наличии.
  if (opts.system) body["system_instruction"] = { parts: [{ text: opts.system }] };

  const data = await generate(
    opts.model ?? process.env["MODEL_SCENE"] ?? "gemini-3.1-pro-preview",
    body,
    opts.timeoutMs ?? 120_000,
  );

  return (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

/**
 * Ответ строго объектом. Как askJson в claude.ts: модель любит обернуть JSON
 * в ```json — срезаем, иначе разбор падает на ровном месте.
 */
export async function geminiJson<T>(opts: TextOptions): Promise<T> {
  const jsonRule = "Отвечай СТРОГО одним JSON-объектом, без пояснений и без markdown.";
  const raw = await geminiText({
    ...opts,
    system: opts.system ? `${opts.system}\n\n${jsonRule}` : jsonRule,
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
    throw new Error("Gemini вернул ответ, который не удалось разобрать как JSON");
  }
}

export async function geminiImage(opts: {
  prompt: string;
  model?: string;
  timeoutMs?: number;
}): Promise<Buffer> {
  const data = await generate(
    opts.model ?? process.env["MODEL_IMAGE"] ?? "gemini-3.1-flash-image",
    {
      contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    },
    opts.timeoutMs ?? 120_000,
  );

  // Модель вправе вернуть текст рядом с картинкой — ищем именно inlineData.
  const part = (data.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
  const b64 = part?.inlineData?.data;
  if (!b64) throw new Error("Gemini не вернул изображение");
  return Buffer.from(b64, "base64");
}
