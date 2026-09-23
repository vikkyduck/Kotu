import { test, describe, expect } from "vitest";
import { fieldsLine, sanitizeSlideContent, settleContent } from "./slide-content";

/**
 * Содержимое слайда приходит из двух ненадёжных мест: от модели и из правок
 * автора в браузере. Кривое поле — число вместо строки, строка вместо списка —
 * валит сборку PPTX уже на выгрузке, когда автор ждёт готовый файл.
 * Здесь проверяется, что до вёрстки доезжает только строгая форма.
 */

describe("приведение слайда к строгой форме", () => {
  test("нормальный слайд проходит как есть", () => {
    const out = sanitizeSlideContent({
      title: "Отрицание не отменяет восприятие",
      bullets: ["Сказанное «нет» уже воспринято", "Отрицание — форма признания"],
      question: "Что в материале нельзя восстановить?",
    });

    expect(out.title).toBe("Отрицание не отменяет восприятие");
    expect(out.bullets?.length).toBe(2);
    expect(out.question).toBe("Что в материале нельзя восстановить?");
  });

  test("не-строка вместо текста отбрасывается, а не уезжает в экспорт", () => {
    const out = sanitizeSlideContent({ title: 42, subtitle: null, quote: { text: "нет" } });

    expect(out.title).toBe(undefined);
    expect(out.subtitle).toBe(undefined);
    expect(out.quote).toBe(undefined);
  });

  test("пустые строки не превращаются в пустые строчки на слайде", () => {
    const out = sanitizeSlideContent({ title: "   ", bullets: ["", "  ", "живой тезис"] });

    expect(out.title).toBe(undefined);
    expect(out.bullets).toEqual(["живой тезис"]);
  });

  test("список тезисов не бесконечный", () => {
    const out = sanitizeSlideContent({ bullets: Array.from({ length: 40 }, (_, i) => `тезис ${i}`) });

    expect(out.bullets?.length).toBe(12);
  });

  test("колонки сравнения: мусор выкидывается, полупустая карточка остаётся", () => {
    const out = sanitizeSlideContent({
      cards: [{ title: "Verneinung", body: "возвращается в символическом" }, "мусор", { title: "Verwerfung" }],
    });

    expect(out.cards?.length).toBe(2);
    expect(out.cards?.[1]).toEqual({ title: "Verwerfung", body: "" });
  });

  test("колонок не больше, чем рисует лист", () => {
    const out = sanitizeSlideContent({
      cards: [1, 2, 3, 4].map((i) => ({ title: `колонка ${i}`, body: "текст" })),
    });

    expect(out.cards?.map((c) => c.title)).toEqual(["колонка 1", "колонка 2"]);
  });

  test("чужие поля не протаскиваются дальше", () => {
    const out = sanitizeSlideContent({ title: "Тезис", onclick: "alert(1)", __proto__: { hack: true } });

    expect(Object.keys(out)).toEqual(["title"]);
  });

  test("вместо объекта пришла ерунда — получаем пустой слайд, а не падение", () => {
    expect(sanitizeSlideContent(null)).toEqual({});
    expect(sanitizeSlideContent("строка")).toEqual({});
    expect(sanitizeSlideContent([1, 2, 3])).toEqual({});
  });

  test("текст не в том поле макета переезжает в видимое, исходное остаётся", () => {
    expect(settleContent("quote", { title: "Слова" })).toEqual({ title: "Слова", quote: "Слова" });
    expect(settleContent("clinical", { subtitle: "Абзац" })).toEqual({ subtitle: "Абзац", bullets: ["Абзац"] });
    expect(settleContent("final", { quote: "Вывод" })).toEqual({ quote: "Вывод", title: "Вывод" });
  });

  test("поле макета заполнено — ничего не переезжает", () => {
    const c = { quote: "Цитата", title: "Заголовок" };
    expect(settleContent("quote", c)).toBe(c);
    expect(settleContent("theory", { subtitle: "x" })).toEqual({ subtitle: "x" });
  });

  test("строка полей для модели — из общей таблицы, с подсказками", () => {
    expect(fieldsLine("quote")).toBe("quote (до 35 слов), attribution");
    expect(fieldsLine("comparison")).toBe("title, cards[] (ровно две карточки {title, body})");
  });
});
