import { describe, expect, test, vi } from "vitest";

/**
 * Тексты уведомлений об итогах задач. База подменена: на каждую таблицу -
 * одна строка с нужным состоянием.
 */

const rowsByTable = vi.hoisted(() => new Map<unknown, Record<string, unknown>>());
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));
vi.mock("@workspace/db", () => {
  const lecturesTable = { name: "lectures" };
  const decksTable = { name: "decks" };
  const transcriptionsTable = { name: "transcriptions" };
  return {
    lecturesTable,
    decksTable,
    transcriptionsTable,
    db: {
      select: () => ({
        from: (table: unknown) => ({ where: () => ({ limit: async () => (rowsByTable.has(table) ? [rowsByTable.get(table)] : []) }) }),
      }),
    },
  };
});
vi.mock("./notify", () => ({ notifyOwner: vi.fn(async () => true) }));

import { decksTable, lecturesTable, transcriptionsTable, type Job } from "@workspace/db";
import { doneText, failedText } from "./done-notice";

const job = (kind: string, entityId = 4) => ({ kind, entityId }) as unknown as Job;

describe("готово", () => {
  test("план лекции - просьба утвердить и ссылка", async () => {
    rowsByTable.set(lecturesTable, { title: "Перенос", status: "plan_ready" });
    expect(await doneText(job("lecture.plan"))).toBe('План лекции "Перенос" готов, его нужно утвердить: https://psy3107.ru/#/lecture/4');
  });

  test("презентация, которую дорисует следующая задача, - пока без сообщения", async () => {
    rowsByTable.set(decksTable, { title: "Сон", status: "drawing" });
    expect(await doneText(job("deck.illustrate"))).toBeNull();
    rowsByTable.set(decksTable, { title: "Сон", status: "ready" });
    expect(await doneText(job("deck.illustrate"))).toBe('Презентация "Сон" готова: https://psy3107.ru/#/deck/4');
  });

  test("расшифровка - ссылка на запись", async () => {
    rowsByTable.set(transcriptionsTable, { title: "Семинар", status: "done" });
    expect(await doneText(job("transcribe"))).toBe('Расшифровка "Семинар" готова: https://psy3107.ru/#/record/4');
  });

  test("индексация библиотеки - без сообщений", async () => {
    expect(await doneText(job("doc.ingest"))).toBeNull();
  });
});

describe("не получилось", () => {
  test("лекция - причина и ссылка", async () => {
    rowsByTable.set(lecturesTable, { title: "Перенос", status: "error" });
    expect(await failedText(job("lecture.write"), "Модель не ответила")).toBe(
      'Лекция "Перенос" не получилась: Модель не ответила. https://psy3107.ru/#/lecture/4',
    );
  });
});
