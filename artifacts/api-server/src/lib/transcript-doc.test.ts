import { test, expect, vi } from "vitest";

/** Копия расшифровки в библиотеке называется, как сама запись. */

// Модуль тянет базу, а без DATABASE_URL она падает прямо при импорте; здесь
// проверяется только подготовка текста и названия — база не нужна.
vi.mock("@workspace/db", () => ({ db: {}, documentsTable: {}, transcriptionsTable: {}, decksTable: {} }));

const { libraryTitle } = await import("./transcript-doc");

const created = new Date("2026-09-23T10:00:00Z");

test("название копии - название записи, обрезанное до 200 знаков", () => {
  expect(libraryTitle({ title: "  Лекция о горе ", createdAt: created })).toBe("Лекция о горе");
  expect(libraryTitle({ title: "я".repeat(500), createdAt: created })).toHaveLength(200);
});

test("пустое название - «Расшифровка от …»", () => {
  expect(libraryTitle({ title: "   ", createdAt: created })).toMatch(/^Расшифровка от /);
});
