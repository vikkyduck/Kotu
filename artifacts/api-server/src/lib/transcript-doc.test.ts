import { test, describe, expect, vi, afterEach } from "vitest";
import type { Transcription } from "@workspace/db";

/**
 * Копия расшифровки в библиотеке — по галочке «Скрыть имена и города».
 * Со скрытием: имена маскируются, название нейтральное, при недоступном NER
 * копия не пишется. Без скрытия (лекции, воркшопы): текст и название как есть.
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

describe("без скрытия имён", () => {
  test("текст и название как есть, сервис имён не вызывается", async () => {
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

describe("со скрытием имён", () => {
  test("имена замаскированы, название нейтральное", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const { text } = JSON.parse(init.body) as { text: string };
      const spans = [...text.matchAll(/Анна/g)].map((m) => ({
        start: m.index!,
        stop: m.index! + 4,
        text: "Анна",
        type: "PER",
      }));
      return { ok: true, json: async () => ({ spans }) };
    });

    const copy = await prepareLibraryCopy(transcription({ hideNames: true }), PLAIN);

    expect(copy.text.includes("Анна"), `имя в копии: ${copy.text}`).toBe(false);
    expect(copy.text).toContain("[[PER1]] рассказала");
    expect(copy.title).toMatch(/^Расшифровка от /);
    expect(copy.title).not.toContain("Лекция о горе");
  });

  test("сервис имён недоступен — копии нет, понятная ошибка", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });

    await expect(prepareLibraryCopy(transcription({ hideNames: true }), PLAIN)).rejects.toThrow(
      "Сервис маскировки недоступен",
    );
  });
});
