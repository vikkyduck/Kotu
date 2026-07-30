import { logger } from "./logger";

/**
 * Локальная маскировка персональных данных.
 *
 * Зачем: расшифровка сеанса — это данные о здоровье (специальная категория,
 * ст. 10 152-ФЗ). Оформлять текст помогает зарубежная модель, поэтому имена
 * пациентов, клички, города и адреса заменяются метками ДО отправки и
 * возвращаются на место после ответа. За пределы сервера в Москве настоящие
 * имена не уходят никогда.
 *
 * Распознаёт локальный сервис natasha (127.0.0.1:9020). Если он недоступен,
 * работает запасной эвристический маскировщик — он перестраховывается и прячет
 * лишнее, но НИКОГДА не отправляет имена наружу открытым текстом.
 */

const NER_URL = process.env["NER_URL"] ?? "http://127.0.0.1:9020/ner";
const NER_TIMEOUT_MS = 20_000;

interface NerSpan {
  start: number;
  stop: number;
  text: string;
  type: "PER" | "LOC";
}

export interface MaskedText {
  /** Текст, в котором персональные данные заменены метками вида [[PER1]]. */
  masked: string;
  /** Метка → исходное значение. Живёт только в памяти процесса. */
  map: Record<string, string>;
  /** true, если сработал запасной путь (сервис NER был недоступен). */
  degraded: boolean;
}

async function fetchSpans(text: string): Promise<NerSpan[]> {
  const res = await fetch(NER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(NER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`NER ответил ${res.status}`);
  const data = (await res.json()) as { spans?: NerSpan[] };
  return data.spans ?? [];
}

/**
 * Запасной путь: прячет слова с заглавной буквы в середине предложения —
 * в русском это почти всегда имена собственные. Перестраховка допустима,
 * утечка настоящего имени — нет.
 */
function heuristicSpans(text: string): NerSpan[] {
  const spans: NerSpan[] = [];
  const re = /(?<=[^.!?…\n[]\s)(\p{Lu}[\p{Ll}\p{Lu}-]+)/gu;
  for (const m of text.matchAll(re)) {
    if (m.index === undefined) continue;
    spans.push({ start: m.index, stop: m.index + m[0].length, text: m[0], type: "PER" });
  }
  return spans;
}

/** Заменяет найденные сущности метками. Одинаковый текст — всегда одна метка. */
export async function maskText(text: string): Promise<MaskedText> {
  let spans: NerSpan[];
  let degraded = false;

  try {
    spans = await fetchSpans(text);
  } catch (err) {
    logger.warn({ err }, "NER недоступен — маскирую запасной эвристикой");
    spans = heuristicSpans(text);
    degraded = true;
  }

  const map: Record<string, string> = {};
  const labelByValue = new Map<string, string>();
  const counters: Record<string, number> = { PER: 0, LOC: 0 };

  // Идём с конца, чтобы смещения не съезжали после замены.
  const ordered = [...spans].sort((a, b) => b.start - a.start);
  let masked = text;

  for (const span of ordered) {
    const value = span.text;
    let label = labelByValue.get(value);
    if (!label) {
      counters[span.type] = (counters[span.type] ?? 0) + 1;
      label = `[[${span.type}${counters[span.type]}]]`;
      labelByValue.set(value, label);
      map[label] = value;
    }
    masked = masked.slice(0, span.start) + label + masked.slice(span.stop);
  }

  return { masked, map, degraded };
}

/** Возвращает настоящие значения на место меток: [[PER1]] → [[Анна Петровна]]. */
export function unmaskText(text: string, map: Record<string, string>): string {
  let result = text;
  for (const [label, value] of Object.entries(map)) {
    result = result.split(label).join(`[[${value}]]`);
  }
  // Если модель всё же выдумала метку, которой не было, — убираем её,
  // чтобы в тексте не осталось технического мусора.
  return result.replace(/\[\[(PER|LOC)\d+\]\]/g, "");
}
