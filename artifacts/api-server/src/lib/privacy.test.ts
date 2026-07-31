import { test, describe, expect, vi, afterEach } from "vitest";
import { maskText, unmaskText } from "./privacy";

/**
 * Главное обещание платформы: настоящие имена пациентов не покидают сервер
 * в Москве. Всё, что уезжает к зарубежным моделям, проходит через maskText.
 *
 * Эти тесты проверяют именно обещание, а не устройство кода: после маскировки
 * в тексте не должно остаться ни одного исходного имени — ни когда локальный
 * сервис распознавания работает, ни когда он лежит.
 */

/** Подменяет ответ сервиса NER, не поднимая его по-настоящему. */
function nerReturns(spans: { start: number; stop: number; text: string; type: "PER" | "LOC" }[]) {
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ spans }) }));
}

/** Сервис лежит: fetch падает так же, как при недоступной сети. */
function nerIsDown() {
  vi.stubGlobal("fetch", async () => {
    throw new Error("connect ECONNREFUSED");
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("маскировка имён", () => {
  test("имя заменяется меткой и в тексте его больше нет", async () => {
    const text = "Пациентка Анна снова говорила о матери.";
    nerReturns([{ start: 10, stop: 14, text: "Анна", type: "PER" }]);

    const { masked, map, degraded } = await maskText(text);

    expect(degraded).toBe(false);
    expect(masked.includes("Анна"), `имя осталось в тексте: ${masked}`).toBe(false);
    expect(masked).toMatch(/\[\[PER1\]\]/);
    expect(map["[[PER1]]"]).toBe("Анна");
  });

  test("одно имя — одна метка, сколько бы раз оно ни встретилось", async () => {
    const text = "Анна пришла. Анна молчала. Анна ушла.";
    nerReturns([
      { start: 0, stop: 4, text: "Анна", type: "PER" },
      { start: 13, stop: 17, text: "Анна", type: "PER" },
      { start: 27, stop: 31, text: "Анна", type: "PER" },
    ]);

    const { masked, map } = await maskText(text);

    expect(masked.includes("Анна")).toBe(false);
    expect(masked.match(/\[\[PER1\]\]/g)?.length).toBe(3);
    expect(Object.keys(map).length).toBe(1);
  });

  test("город и имя получают разные метки", async () => {
    const text = "Анна уехала в Тверь.";
    nerReturns([
      { start: 0, stop: 4, text: "Анна", type: "PER" },
      { start: 14, stop: 19, text: "Тверь", type: "LOC" },
    ]);

    const { masked, map } = await maskText(text);

    expect(masked.includes("Анна")).toBe(false);
    expect(masked.includes("Тверь")).toBe(false);
    expect(map["[[PER1]]"]).toBe("Анна");
    expect(map["[[LOC1]]"]).toBe("Тверь");
  });

  test("сервис распознавания лежит — имена всё равно скрыты", async () => {
    const text = "Сегодня Анна говорила о брате, потом вспомнила Тверь.";
    nerIsDown();

    const { masked, degraded } = await maskText(text);

    expect(degraded, "падение сервиса должно быть видно вызывающему").toBe(true);
    expect(masked.includes("Анна"), `имя утекло через запасной путь: ${masked}`).toBe(false);
    expect(masked.includes("Тверь"), `город утёк через запасной путь: ${masked}`).toBe(false);
  });

  test("запасной путь не трогает первое слово предложения", async () => {
    // Эвристика прячет заглавные слова в середине фразы. Начало предложения
    // всегда с заглавной, и прятать его значило бы съесть текст целиком.
    nerIsDown();

    const { masked } = await maskText("Сегодня она молчала.");

    expect(masked).toBe("Сегодня она молчала.");
  });
});

describe("возврат имён на место", () => {
  test("метки заменяются настоящими значениями", () => {
    const result = unmaskText("Пациентка [[PER1]] говорила о [[LOC1]].", {
      "[[PER1]]": "Анна",
      "[[LOC1]]": "Тверь",
    });

    expect(result).toBe("Пациентка [[Анна]] говорила о [[Тверь]].");
  });

  test("выдуманная моделью метка не остаётся мусором в тексте", () => {
    const result = unmaskText("Она вспомнила [[PER7]] и замолчала.", {});

    expect(result).toBe("Она вспомнила  и замолчала.");
  });
});
