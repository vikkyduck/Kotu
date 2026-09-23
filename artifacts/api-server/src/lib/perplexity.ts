import { failHttp } from "./http-fail";

/**
 * Веб-исследование через Perplexity — для лекций в режиме «исследование ИИ».
 *
 * Ходит через тот же транзит, что и остальные зарубежные модели (зона Б:
 * наружу уходит только тема лекции, никаких персональных данных). Perplexity
 * выбран потому, что отвечает выжимкой с настоящими ссылками на источники —
 * их можно открыть и сверить, а для академической аудитории это обязательно.
 *
 * Ключ вводится вслепую через ./set-ai-key.sh (пункт 3). Пока ключа нет,
 * isResearchAvailable() возвращает false, и лекция честно пишется по знаниям
 * модели с пометкой — а не падает и не выдумывает ссылок.
 */

const BASE_URL = process.env["PERPLEXITY_BASE_URL"] ?? "http://127.0.0.1:8444/perplexity";
const API_KEY = process.env["PERPLEXITY_API_KEY"] ?? "";
const MODEL = process.env["MODEL_RESEARCH"] ?? "sonar-pro";
const TIMEOUT_MS = 180_000;

export interface WebSource {
  n: number;
  url: string;
  title: string;
}

export interface ResearchResult {
  /** Выжимка по теме со ссылками вида [1], [2] внутри текста. */
  summary: string;
  sources: WebSource[];
}

export function isResearchAvailable(): boolean {
  return API_KEY !== "";
}

/** Одно исследование: вопрос → выжимка с пронумерованными источниками. */
export async function research(query: string): Promise<ResearchResult> {
  if (!isResearchAvailable()) throw new Error("Ключ Perplexity не настроен");

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: [
            "Ты помогаешь преподавателю психоанализа собрать материал по теме.",
            "Отвечай по-русски, подробной выжимкой: понятия, авторы, работы, даты, споры.",
            "Опирайся на надёжные источники: научные публикации, классические тексты,",
            "профильные издания. Ссылки на источники давай в виде [1], [2] по ходу текста.",
          ].join("\n"),
        },
        { role: "user", content: query },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) return failHttp(res, "Веб-поиск");

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    citations?: string[];
    search_results?: { title?: string; url?: string }[];
  };

  const summary = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (summary === "") throw new Error("Веб-поиск вернул пустой ответ");

  // Источники приходят двумя способами в зависимости от версии API —
  // берём тот, что богаче (с названиями), падаем на голые URL.
  const fromResults = (data.search_results ?? [])
    .filter((s) => typeof s.url === "string" && s.url !== "")
    .map((s, i) => ({ n: i + 1, url: s.url!, title: s.title || s.url! }));
  const fromCitations = (data.citations ?? [])
    .filter((u) => typeof u === "string" && u !== "")
    .map((u, i) => ({ n: i + 1, url: u, title: u }));

  const sources = fromResults.length > 0 ? fromResults : fromCitations;
  return { summary, sources };
}
