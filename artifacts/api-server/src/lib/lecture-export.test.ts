import { test, describe, expect } from "vitest";
import type { Lecture, LectureSection, LectureSource } from "@workspace/db";
import { buildLectureDocx, buildLectureMarkdown, type LectureFull } from "./lecture-export";

/**
 * Выгрузка лекции: Word и Markdown собираются из одних данных и не должны
 * терять ни главы, ни источники, ни литературу.
 */

const full: LectureFull = {
  id: 1,
  ownerId: 1,
  title: "Работа негатива",
  folderId: null,
  brief: { topic: "т", audience: "коллеги", durationMin: 60, documentIds: [] },
  plan: null,
  planNotes: null,
  bibliography: {
    primary: ["Freud S. Die Verneinung (1925)"],
    modern: ["Ogden T. This Art of Psychoanalysis (2005)"],
  },
  planApproved: true,
  status: "ready",
  statusMessage: "",
  error: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  sections: [
    {
      id: 10,
      lectureId: 1,
      ord: 0,
      heading: "Отрицание у Фрейда",
      abstract: "",
      text: "Первый абзац главы.\n\nВторой абзац главы [1].",
      editedByHuman: false,
      status: "ready",
    } as LectureSection,
  ],
  sources: [
    {
      id: 100,
      lectureId: 1,
      sectionId: 10,
      kind: "web",
      chunkId: null,
      url: "https://example.org/verneinung",
      title: "PEP-Web: Die Verneinung",
      quote: "цитата",
      createdAt: new Date(0),
    } as LectureSource,
  ],
} as unknown as LectureFull;

describe("выгрузка лекции", () => {
  test("markdown держит главы, источники со ссылками и литературу", () => {
    const md = buildLectureMarkdown(full);

    expect(md).toContain("# Работа негатива");
    expect(md).toContain("## Отрицание у Фрейда");
    expect(md).toContain("Второй абзац главы [1].");
    expect(md).toContain("PEP-Web: Die Verneinung — https://example.org/verneinung");
    expect(md).toContain("Freud S. Die Verneinung (1925)");
    expect(md).toContain("Ogden T. This Art of Psychoanalysis (2005)");
  });

  test("word собирается и содержит текст лекции", async () => {
    const buf = await buildLectureDocx(full);

    // .docx — это zip: PK в начале и непустое тело.
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    expect(buf.length).toBeGreaterThan(2_000);
  });
});
