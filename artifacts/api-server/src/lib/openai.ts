import OpenAI from "openai";

/**
 * Клиент OpenAI через собственный транзит (см. ARCHITECTURE.md §5): как и с
 * Claude и Gemini, из России напрямую запросы не проходят.
 */
export const OPENAI_BASE_URL =
  process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "http://127.0.0.1:8444/v1";
export const OPENAI_API_KEY = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "";

// Без ключа SDK всё равно падает при создании клиента — пусть по-русски.
if (OPENAI_API_KEY === "") throw new Error("OpenAI не подключён: нет AI_INTEGRATIONS_OPENAI_API_KEY");

export const openai = new OpenAI({ apiKey: OPENAI_API_KEY, baseURL: OPENAI_BASE_URL });
