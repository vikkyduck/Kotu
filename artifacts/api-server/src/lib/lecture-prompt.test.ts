import { test, expect } from "vitest";
import { renumberCitations } from "./lecture-prompt";

test("renumberCitations: номера в тексте совпадают со списком источников под главой", () => {
  // Процитированы выдержка 3 и веб-источник 7 — под главой они станут 1 и 2.
  expect(renumberCitations("Фрейд [3], Кляйн [7], снова [3].", [3, 7])).toBe(
    "Фрейд [1], Кляйн [2], снова [1].",
  );
  // Номер, которого не было в материале, не трогаем.
  expect(renumberCitations("Выдумка [9] и [3]", [3])).toBe("Выдумка [9] и [1]");
  expect(renumberCitations("Без ссылок", [])).toBe("Без ссылок");
});
