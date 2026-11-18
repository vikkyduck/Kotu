import { test, describe, expect, vi, afterEach } from "vitest";
import type { Transcription } from "@workspace/db";

/**
 * Копия расшифровки в библиотеке: текст и название как есть. Скрытия имён
 * больше нет (решение владелицы 18.11.2026); старые записи со скрытием
 * сохраняют нейтральное название, текст копии не маскируется.
 */

// Модуль тянет базу, а без DATABASE_URL она падает прямо при импорте; здесь
// проверяется только подготовка текста и названия — база не нужна.
vi.mock("@workspace/db", () => ({ db: {}, documentsTable: {}, transcriptionsTable: {}, decksTable: {} }));

const { prepareLibraryCopy } = await import("./transcript-doc");

const PLAIN = "Анна рассказала о матери. ".repeat(10).trim();

function transcription(over: Partial<Transcription>): Transcription {
  return {
    id: 7,
    ownerId: 1,
    title: "Лекция о горе",
    filename: "lecture.m4a",
    hideNames: false,
    markSpeakers: false,
    segments: [],
    status: "done",
    progress: 100,
    statusMessage: "",
    error: null,
    createdAt: new Date("2026-09-23T10:00:00Z"),
    updatedAt: new Date("2026-09-23T10:00:00Z"),
    ...over,
  } as Transcription;
}

afterEach(() => vi.unstubAllGlobals());

describe("обычная запись", () => {
  test("текст и название как есть, никаких внешних вызовов", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const copy = await prepareLibraryCopy(transcription({ hideNames: false }), PLAIN);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(copy).toEqual({ text: PLAIN, title: "Лекция о горе" });
  });

  test("пустое название — нейтральное, длинное — обрезано до 200 знаков", async () => {
    const empty = await prepareLibraryCopy(transcription({ title: "   " }), PLAIN);
    expect(empty.title).toMatch(/^Расшифровка от /);

    const long = await prepareLibraryCopy(transcription({ title: "я".repeat(500) }), PLAIN);
    expect(long.title).toHaveLength(200);
  });
});

describe("старая запись со скрытием имён", () => {
  test("текст как есть, никаких внешних вызовов, название нейтральное", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const copy = await prepareLibraryCopy(transcription({ hideNames: true }), PLAIN);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(copy.text).toBe(PLAIN);
    expect(copy.title).toMatch(/^Расшифровка от /);
    expect(copy.title).not.toContain("Лекция о горе");
  });
});
