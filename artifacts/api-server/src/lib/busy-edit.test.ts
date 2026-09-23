import { test, expect } from "vitest";
import { planEditBlocked, segmentsEditBlocked } from "./busy-edit";
import { ARCHIVED_TABLES } from "./archive-sql";

/**
 * Правка поля, которое пишет машина, пока строка «в работе», затёрлась бы без
 * версии в архиве. Такие правки отклоняются, прочие — нет.
 */

test("текст расшифровки в работе править нельзя, название — можно", () => {
  expect(segmentsEditBlocked("processing", { segments: [] })).toBe(true);
  expect(segmentsEditBlocked("processing", { title: "Сеанс" } as { segments?: unknown })).toBe(false);
  expect(segmentsEditBlocked("done", { segments: [] })).toBe(false);
  expect(segmentsEditBlocked("error", { segments: [] })).toBe(false);
});

test("план лекции, пока он составляется, править нельзя", () => {
  expect(planEditBlocked("planning")).toBe(true);
  expect(planEditBlocked("plan_ready")).toBe(false);
});

test("запреты совпадают с тем, что архив считает машинным выводом", () => {
  const t = ARCHIVED_TABLES.find((x) => x.table === "transcriptions")!;
  expect(t.busy).toContain("processing");
  expect(t.machine).toContain("segments");
  const l = ARCHIVED_TABLES.find((x) => x.table === "lectures")!;
  expect(l.busy).toContain("planning");
  expect(l.machine).toContain("plan");
});
