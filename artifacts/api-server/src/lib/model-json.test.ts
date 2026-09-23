import { test, expect } from "vitest";
import { parseModelJson } from "./model-json";

/** Один разбор ответа на Claude, Gemini и приёмку — сырой SyntaxError наружу не выходит. */

test("чистый объект и объект в ```json", () => {
  expect(parseModelJson('{"a":1}', "Claude")).toEqual({ a: 1 });
  expect(parseModelJson('```json\n{"a":1}\n```', "Claude")).toEqual({ a: 1 });
});

test("фраза вокруг объекта — вынимаем сам объект", () => {
  expect(parseModelJson('Вот ответ: {"a":1} — готово', "Gemini")).toEqual({ a: 1 });
});

test("битый объект внутри фразы — человеческая ошибка, а не SyntaxError", () => {
  expect(() => parseModelJson('Вот: {"scene":"a" "b"}', "Gemini")).toThrow(
    "Gemini вернул ответ, который не удалось разобрать как JSON",
  );
});
