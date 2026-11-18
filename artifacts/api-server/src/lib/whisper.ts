import OpenAI from "openai";

/**
 * Локальный распознаватель речи (kotu-whisper). Он отвечает в формате
 * OpenAI API (/v1/audio/transcriptions), поэтому для него берем SDK OpenAI.
 * Ключ ему не нужен, а аудио не покидает сервер.
 *
 * Адрес по умолчанию - внутренний маршрутизатор nginx, который отправляет
 * /v1/audio/* в локальный Whisper (ARCHITECTURE.md §5).
 */
export const whisper = new OpenAI({
  // Не ключ: локальный Whisper ключей не проверяет, а библиотеке нужно непустое значение.
  apiKey: "local-whisper",
  baseURL: process.env["WHISPER_BASE_URL"] ?? "http://127.0.0.1:8444/v1",
});
