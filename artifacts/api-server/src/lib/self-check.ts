import { askText, ModelWaitError, MODEL_TASKS, modelFor } from "./codex";
import { checkMail } from "./mail";
import { notifyOwner } from "./notify";
import { logger } from "./logger";

/**
 * Самопроверка платформы: всё ли, без чего не работают задачи, на месте.
 *
 * Зачем: после переезда две поломки неделями прошли бы молча - письма сброса
 * пароля не уходили (SMTP закрыт), а расшифровки падали на модели, которую
 * подписка не принимает. Обе ловятся одним коротким запросом при запуске.
 *
 * Что проверяем: каждую модель из .env (коротким запросом через мост),
 * локальный Whisper, векторы библиотеки и почту (письмо на адрес симулятора
 * Postbox, которое никому не приходит). Найдено что-то - сообщение владелице в
 * Telegram через мост ПСИ. Повторно о том же не пишем; когда всё снова в
 * порядке - пишем один раз. Проверка при запуске, затем раз в 12 часов.
 */

const FIRST_DELAY_MS = 60_000;
/** Найдена проблема - перепроверяем через 3 минуты: сервис мог просто стартовать. */
const RECHECK_DELAY_MS = 3 * 60_000;
const PERIOD_MS = 12 * 60 * 60_000;
const HTTP_TIMEOUT_MS = 20_000;

/** Модели, которые зовут задачи, - из общего реестра codex.ts (modelFor). */
export function configuredModels(): { env: string; model: string }[] {
  return MODEL_TASKS.map((env) => ({ env, model: modelFor(env) }));
}

async function checkModels(): Promise<string[]> {
  const byModel = new Map<string, string[]>();
  for (const { env, model } of configuredModels()) {
    byModel.set(model, [...(byModel.get(model) ?? []), env]);
  }
  const problems: string[] = [];
  for (const [model, envs] of byModel) {
    try {
      await askText({ model, system: "Ответь одним словом: ок.", user: "Проверка связи." });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      problems.push(
        err instanceof ModelWaitError
          ? `модели недоступны (${envs.join(", ")} = ${model}): ${message}`
          : `модель ${model} не отвечает (${envs.join(", ")}): ${message}`,
      );
    }
  }
  return problems;
}

async function checkWhisper(): Promise<string | null> {
  const base = (process.env["WHISPER_BASE_URL"] ?? "http://127.0.0.1:8444/v1").replace(/\/+$/, "");
  try {
    // Запрос без файла: живой Whisper отвечает отказом в данных (4xx), а
    // лежащий - ошибкой маршрутизатора (5xx) или не отвечает вовсе.
    const res = await fetch(`${base}/audio/transcriptions`, { method: "POST", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    return res.status < 500 ? null : `распознавание речи (Whisper) не отвечает: ${res.status}`;
  } catch (err) {
    return `распознавание речи (Whisper) не отвечает: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function checkEmbeddings(): Promise<string | null> {
  const url = process.env["EMBED_URL"] ?? "http://127.0.0.1:9030/embed";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: ["проверка"], kind: "query" }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return `векторы библиотеки не отвечают: ${res.status}`;
    const data = (await res.json()) as { vectors?: unknown[] };
    return Array.isArray(data.vectors) && data.vectors.length === 1 ? null : "векторы библиотеки отвечают без векторов";
  } catch (err) {
    return `векторы библиотеки не отвечают: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Все проверки разом. Пустой список - всё в порядке. */
export async function runSelfCheck(): Promise<string[]> {
  const [models, whisper, embed, mail] = await Promise.all([
    checkModels(),
    checkWhisper(),
    checkEmbeddings(),
    checkMail(),
  ]);
  return [...models, whisper, embed, mail].filter((p): p is string => p !== null);
}

let lastNotified: string[] = [];

/**
 * Одна проверка с перепроверкой и сообщением владелице. Возвращает найденное.
 * delay - для тестов: пауза перед перепроверкой.
 */
export async function checkAndNotify(delay: (ms: number) => Promise<void> = sleep): Promise<string[]> {
  let problems = await runSelfCheck();
  if (problems.length > 0) {
    await delay(RECHECK_DELAY_MS);
    problems = await runSelfCheck();
  }
  const same = problems.length === lastNotified.length && problems.every((p, i) => p === lastNotified[i]);
  if (problems.length > 0) {
    logger.error({ problems }, "Самопроверка нашла проблемы");
    if (!same && (await notifyOwner(`Платформа psy3107.ru: самопроверка нашла проблемы.\n- ${problems.join("\n- ")}\nЖурнал: journalctl -u kotu`))) {
      lastNotified = problems;
    }
  } else {
    logger.info("Самопроверка: всё в порядке");
    if (lastNotified.length > 0 && (await notifyOwner("Платформа psy3107.ru: самопроверка снова в порядке."))) {
      lastNotified = [];
    }
  }
  return problems;
}

/** Только для тестов. */
export function resetSelfCheckState(): void {
  lastNotified = [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** Запуск при старте и раз в 12 часов. SELF_CHECK=off - выключить. */
export function startSelfCheck(): void {
  if ((process.env["SELF_CHECK"] ?? "on") === "off") return;
  const run = () =>
    void checkAndNotify().catch((err) => logger.error({ err }, "Самопроверка упала"));
  setTimeout(run, FIRST_DELAY_MS).unref();
  setInterval(run, PERIOD_MS).unref();
}
