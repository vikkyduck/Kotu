import { expect, test, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// Без DATABASE_URL модуль базы падает при импорте; здесь нужен только запрос.
vi.mock("@workspace/db", async () => ({ ...(await import("@workspace/db/schema")), db: {} }));

const { briefHasDocument } = await import("./relations");

test("лекции с документом в опоре: id документа уходит параметром, а не текстом запроса", () => {
  const q = new PgDialect().sqlToQuery(briefHasDocument(19));
  expect(q.sql).toContain(`-> 'documentIds' @> $1::jsonb`);
  expect(q.sql).not.toContain("19");
  expect(q.params).toEqual(["[19]"]);
});
