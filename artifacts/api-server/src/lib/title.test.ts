import { expect, test } from "vitest";
import { TITLE_MAX, titleFrom } from "./title";

test("titleFrom: обрезает края и длину, не строку превращает в пустое", () => {
  expect(titleFrom("  Сны  ")).toBe("Сны");
  expect(titleFrom("я".repeat(TITLE_MAX + 50))).toHaveLength(TITLE_MAX);
  expect(titleFrom(42)).toBe("");
  expect(titleFrom(undefined)).toBe("");
});
