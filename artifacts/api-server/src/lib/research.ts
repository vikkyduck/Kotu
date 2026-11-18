import { askText, pickModel, type WebSource } from "./codex";

/**
 * Веб-исследование для лекций в режиме "исследование ИИ".
 *
 * Раньше это делал Perplexity по отдельному ключу. Теперь - веб-поиск Codex
 * по подписке (lib/codex.ts): модель обязана сходить в поиск, а ссылки из
 * ответа превращаются в номера [n] со списком источников. Наружу уходит
 * только тема лекции, персональных данных здесь нет.
 */

export type { WebSource };

export interface ResearchResult {
  /** Выжимка по теме со ссылками вида [1], [2] внутри текста. */
  summary: string;
  sources: WebSource[];
}

const SYSTEM = [
  "Ты помогаешь преподавателю психоанализа собрать материал по теме.",
  "Найди материал веб-поиском и отвечай по-русски подробной выжимкой: понятия, авторы, работы, даты, споры.",
  "Опирайся на надежные источники: научные публикации, классические тексты, профильные издания.",
  "Каждое утверждение подкрепляй ссылкой на найденный источник по ходу текста.",
].join("\n");

/** Веб-поиск идет через подписку Codex, отдельный ключ не нужен. */
export function isResearchAvailable(): boolean {
  return true;
}

/** Одно исследование: вопрос -> выжимка с пронумерованными источниками. */
export async function research(query: string): Promise<ResearchResult> {
  const answer = await askText({
    model: pickModel("MODEL_RESEARCH", pickModel("MODEL_LECTURE", "gpt-5.6-sol")),
    system: SYSTEM,
    user: query,
    webSearch: true,
  });
  const summary = answer.text.trim();
  if (summary === "") throw new Error("Веб-поиск вернул пустой ответ");
  return { summary, sources: answer.sources };
}
