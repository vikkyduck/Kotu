import { test, describe, expect, vi, afterEach } from "vitest";
import { hideLabels, maskText, unmaskText, NerUnavailableError } from "./privacy";

/**
 * Главное обещание платформы: настоящие имена пациентов не покидают сервер
 * в Москве. Всё, что уезжает к зарубежным моделям, проходит через maskText.
 *
 * Эти тесты проверяют именно обещание, а не устройство кода: после маскировки
 * в тексте не должно остаться ни одного исходного имени, а когда локальный
 * сервис распознавания лежит, maskText не отдаёт текст вовсе — только ошибку.
 */

/** Подменяет ответ сервиса NER, не поднимая его по-настоящему. */
function nerReturns(spans: { start: number; stop: number; text: string; type: "PER" | "LOC" }[]) {
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ spans }) }));
}

/** Подменяет fetch целиком — для сбоев сервиса NER. */
function nerFetch(impl: () => Promise<unknown>) {
  vi.stubGlobal("fetch", impl);
}

afterEach(() => vi.unstubAllGlobals());

describe("маскировка имён", () => {
  test("имя заменяется меткой и в тексте его больше нет", async () => {
    const text = "Пациентка Анна снова говорила о матери.";
    nerReturns([{ start: 10, stop: 14, text: "Анна", type: "PER" }]);

    const { masked, map } = await maskText(text);

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

  test("имён нет — текст уходит как есть", async () => {
    nerReturns([]);

    const { masked, map } = await maskText("Сегодня она молчала.");

    expect(masked).toBe("Сегодня она молчала.");
    expect(map).toEqual({});
  });
});

describe("сервис распознавания недоступен — текст не отдаём", () => {
  // Запасной эвристики больше нет: она пропускала имя в начале предложения.
  // Любой сбой NER — отказ, а не «как-нибудь замаскированный» текст.
  const text = "Анна говорила о брате, потом вспомнила Тверь.";

  test("сеть недоступна", async () => {
    nerFetch(async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    });
    await expect(maskText(text)).rejects.toBeInstanceOf(NerUnavailableError);
  });

  test("сервис ответил 500", async () => {
    nerFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(maskText(text)).rejects.toBeInstanceOf(NerUnavailableError);
  });

  test("сервис не ответил вовремя", async () => {
    nerFetch(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    await expect(maskText(text)).rejects.toBeInstanceOf(NerUnavailableError);
  });

  test("сервис вернул битый JSON", async () => {
    nerFetch(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }));
    await expect(maskText(text)).rejects.toBeInstanceOf(NerUnavailableError);
  });

  test("ответ без списка spans не считается «имён нет»", async () => {
    nerFetch(async () => ({ ok: true, json: async () => ({ error: "model not loaded" }) }));
    await expect(maskText(text)).rejects.toBeInstanceOf(NerUnavailableError);
  });

  test("ошибка понятна человеку и называется по-своему", async () => {
    nerFetch(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const err = await maskText(text).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NerUnavailableError);
    expect((err as Error).name).toBe("NerUnavailableError");
    expect((err as Error).message).toMatch(/Сервис скрытия имён недоступен/);
    expect((err as Error).message.includes("Анна")).toBe(false);
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

describe("смещения из Python сверяются с текстом", () => {
  test("эмодзи перед именем не сдвигает метку", async () => {
    // Python считает 🙂 одним символом, JS — двумя: смещения natasha на 1 меньше.
    const text = "🙂 Анна снова пришла.";
    nerReturns([{ start: 2, stop: 6, text: "Анна", type: "PER" }]);

    const { masked } = await maskText(text);

    expect(masked).toBe("🙂 [[PER1]] снова пришла.");
  });

  test("смещения не совпадают с именем — текст не отдаём", async () => {
    nerReturns([{ start: 0, stop: 4, text: "Анна", type: "PER" }]);

    await expect(maskText("Пациентка Анна пришла.")).rejects.toBeInstanceOf(NerUnavailableError);
  });

  test("пересекающиеся спаны — текст не отдаём", async () => {
    const text = "Анна Петровна пришла.";
    nerReturns([
      { start: 0, stop: 13, text: "Анна Петровна", type: "PER" },
      { start: 5, stop: 13, text: "Петровна", type: "PER" },
    ]);

    await expect(maskText(text)).rejects.toBeInstanceOf(NerUnavailableError);
  });
});

test("hideLabels: метки копии в выдаче — «имя скрыто», «место скрыто»", () => {
  expect(hideLabels("[[PER1]] из [[LOC12]] говорит с [[PER2]]")).toBe(
    "имя скрыто из место скрыто говорит с имя скрыто",
  );
});
