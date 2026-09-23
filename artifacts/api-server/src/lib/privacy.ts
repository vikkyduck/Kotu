/**
 * Локальная маскировка персональных данных.
 *
 * Зачем: расшифровка сеанса — это данные о здоровье (специальная категория,
 * ст. 10 152-ФЗ). Оформлять текст помогает зарубежная модель, поэтому имена
 * пациентов, клички, города и адреса заменяются метками ДО отправки и
 * возвращаются на место после ответа.
 *
 * Распознаёт только локальный сервис natasha (127.0.0.1:9020). Запасного пути
 * нет намеренно: прежняя эвристика «заглавная буква в середине фразы» по
 * построению пропускала имя в начале предложения и строки. Если сервис
 * недоступен или ответил непонятно, maskText бросает NerUnavailableError, и
 * вызывающий НЕ отправляет текст наружу — лучше задержка, чем утечка.
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
}

/**
 * Сервис распознавания имён недоступен — текст замаскировать нечем, значит
 * отправлять его наружу нельзя. Отдельный класс, чтобы вызывающие отличали
 * «временно подождать» от настоящей поломки и говорили человеку понятное.
 */
export class NerUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Сервис скрытия имён недоступен — текст с именами наружу не отправляю", { cause });
    this.name = "NerUnavailableError";
  }
}

/** Проверяем ответ, а не верим ему: пустой или кривой ответ = маскировка не сделана. */
function isValidSpans(spans: unknown, textLength: number): spans is NerSpan[] {
  return (
    Array.isArray(spans) &&
    spans.every(
      (s: Partial<NerSpan> | null) =>
        s !== null &&
        typeof s === "object" &&
        Number.isInteger(s.start) &&
        Number.isInteger(s.stop) &&
        s.start! >= 0 &&
        s.start! < s.stop! &&
        s.stop! <= textLength &&
        typeof s.text === "string" &&
        (s.type === "PER" || s.type === "LOC"),
    )
  );
}

async function fetchSpans(text: string): Promise<NerSpan[]> {
  try {
    const res = await fetch(NER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(NER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`NER ответил ${res.status}`);
    const data = (await res.json()) as { spans?: unknown };
    // Ответ без массива spans нельзя читать как «имён нет»: так немаскированный
    // текст уехал бы наружу из-за сбоя сервиса.
    if (!isValidSpans(data?.spans, text.length)) {
      throw new Error("NER вернул ответ без корректного списка spans");
    }
    return data.spans;
  } catch (err) {
    throw new NerUnavailableError(err);
  }
}

/**
 * Заменяет найденные сущности метками. Одинаковый текст — всегда одна метка.
 * Бросает {@link NerUnavailableError}, если сервис NER недоступен.
 */
export async function maskText(text: string): Promise<MaskedText> {
  const spans = await fetchSpans(text);

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

  return { masked, map };
}

/**
 * Возвращает настоящие значения на место меток.
 * По умолчанию оборачивает их скобками: [[PER1]] → [[Анна Петровна]] — так
 * фронт узнаёт имя и показывает «имя скрыто». С brackets: false — просто
 * «Анна Петровна», как в расшифровке, где имена скрывать не просили.
 */
export function unmaskText(
  text: string,
  map: Record<string, string>,
  { brackets = true }: { brackets?: boolean } = {},
): string {
  let result = text;
  for (const [label, value] of Object.entries(map)) {
    result = result.split(label).join(brackets ? `[[${value}]]` : value);
  }
  // Если модель всё же выдумала метку, которой не было, — убираем её,
  // чтобы в тексте не осталось технического мусора.
  return result.replace(/\[\[(PER|LOC)\d+\]\]/g, "");
}
