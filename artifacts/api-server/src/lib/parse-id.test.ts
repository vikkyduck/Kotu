import { test, expect } from "vitest";
import { parseId } from "./parse-id";
import { attachmentHeader } from "./filename";

test("parseId: только целое положительное из цифр", () => {
  expect(parseId("12")).toBe(12);
  for (const bad of ["0", "-1", "1.5", "1e3", "0x10", "", "abc", " 7", undefined, 7]) {
    expect(parseId(bad)).toBeNull();
  }
});

test("attachmentHeader: очищенное имя, запасное ASCII, пустое → fallback", () => {
  const h = attachmentHeader("Лекция: «Горе» (часть 1)", "pdf", "презентация");
  expect(h).toContain('filename="download.pdf"');
  expect(decodeURIComponent(h.split("''")[1]!)).toBe("Лекция Горе часть 1.pdf");
  expect(decodeURIComponent(attachmentHeader("'''", "docx", "лекция").split("''")[1]!)).toBe("лекция.docx");
  expect(decodeURIComponent(attachmentHeader("я".repeat(100), "md", "x").split("''")[1]!)).toBe(`${"я".repeat(60)}.md`);
});
