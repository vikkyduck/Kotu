import { describe, expect, test, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * Очередь и ожидание подписки Codex: задача, которой нужна модель, а
 * подписка временно недоступна, не тратит попытку и не падает, а
 * откладывается до времени сброса. База подменена: тест читает SQL,
 * который очередь отправила бы в Postgres.
 */

const execute = vi.hoisted(() => vi.fn(async (_q: SQL) => ({ rows: [], rowCount: 0 })));
vi.mock("@workspace/db", () => ({ db: { execute }, jobsTable: {} }));

import { finish, registerHandler } from "./jobs";
import { ModelWaitError } from "./codex";

const dialect = new PgDialect();
const lastQuery = () => dialect.sqlToQuery(execute.mock.calls.at(-1)![0]);

const job = {
  id: 7,
  kind: "lecture.write",
  entityId: 42,
  payload: {},
  status: "running",
  attempts: 2,
  lastError: null,
  runAfter: new Date(),
  lockedAt: new Date(),
  createdAt: new Date(),
  finishedAt: null,
} as const;

const onGiveUp = vi.fn(async () => undefined);
const onWait = vi.fn(async () => undefined);
registerHandler("lecture.write", { run: async () => undefined, onGiveUp, onWait });

beforeEach(() => {
  execute.mockClear();
  onGiveUp.mockClear();
  onWait.mockClear();
});

describe("ожидание подписки", () => {
  test("задача возвращается в очередь до сброса, попытка не тратится", async () => {
    const until = new Date("2026-11-18T12:30:00Z");
    await finish({ ...job }, new ModelWaitError("Ждем Codex: лимит подписки Codex исчерпан", until, "quota"));

    const { sql, params } = lastQuery();
    expect(sql).toContain("status = 'queued'");
    expect(sql).toContain("attempts = GREATEST(attempts - 1, 0)");
    expect(params).toContain(until.toISOString());
    expect(params).toContain("Ждем Codex: лимит подписки Codex исчерпан");
    expect(onWait).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), "Ждем Codex: лимит подписки Codex исчерпан");
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  test("последняя попытка с ожиданием - не провал", async () => {
    await finish({ ...job, attempts: 3 }, new ModelWaitError("Ждем", new Date(Date.now() + 60_000), "signin"));
    expect(lastQuery().sql).not.toContain("'error'");
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  test("обычная ошибка на последней попытке - провал, как раньше", async () => {
    await finish({ ...job, attempts: 3 }, new Error("Модель вернула план в непонятном виде"));
    expect(lastQuery().sql).toContain("status = 'error'");
    expect(onGiveUp).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), "Модель вернула план в непонятном виде");
  });

  test("обычная ошибка с запасом попыток - повтор через паузу", async () => {
    await finish({ ...job, attempts: 1 }, new Error("Связь прервалась"));
    const { sql, params } = lastQuery();
    expect(sql).toContain("status = 'queued'");
    expect(sql).not.toContain("GREATEST");
    expect(params).toContain("30 seconds");
  });
});
