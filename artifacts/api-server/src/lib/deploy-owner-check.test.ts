import { test, describe, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureArchiveWith } from "./archive-sql";
import { createTestDb, type TestDb } from "./archive-test-db";

/**
 * Проверка владельцев из deploy.sh (шаг 4) — тот самый текст SQL из
 * скрипта, на настоящем Postgres (PGlite). psql-переменную :'u' подставляем
 * так же, как psql: строковым литералом.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const deploySh = readFileSync(path.resolve(here, "../../../../deploy.sh"), "utf8");
const match = /<<'SQL'\n([\s\S]*?)\nSQL\n/.exec(deploySh);
if (!match) throw new Error("В deploy.sh не нашёл проверку владельцев (<<'SQL' … SQL)");
const OWNER_CHECK = match[1]!;

let db: TestDb;

async function check(user: string): Promise<string[]> {
  const text = OWNER_CHECK.replaceAll(":'u'", `'${user.replaceAll("'", "''")}'`);
  const { rows } = await db.query(text);
  return rows.map((r) => String(r["what"]));
}

beforeAll(async () => {
  db = await createTestDb();
  await ensureArchiveWith(db.runner);
  await db.pg.exec(`CREATE ROLE kotu LOGIN`);
}, 60_000);

afterAll(async () => {
  await db?.pg.close();
});

describe("deploy.sh: проверка владельцев перед заливкой", () => {
  test("всё принадлежит суперпользователю, от него же и работаем — чисто", async () => {
    expect(await check("postgres")).toEqual([]);
  });

  test("чужой владелец: таблицы, функции архива; последовательность — только вместе с таблицей", async () => {
    const lines = await check("kotu");
    expect(lines).toContain("public.transcriptions (владелец postgres)");
    expect(lines).toContain("archive.rows (владелец postgres)");
    expect(lines).toContain("функция archive.capture_row (владелец postgres)");
    // Таблица archive.rows уже в списке — её последовательность отдельно не выводится.
    expect(lines.filter((l) => l.includes("_seq"))).toEqual([]);
    expect(lines.filter((l) => l.startsWith("public."))).toHaveLength(10);
  });

  test("всё передано приложению — чисто", async () => {
    await db.pg.exec(`
      DO $$ DECLARE r record; BEGIN
        FOR r IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public', 'archive') LOOP
          EXECUTE format('ALTER TABLE %I.%I OWNER TO kotu', r.schemaname, r.tablename);
        END LOOP;
      END $$;
      ALTER FUNCTION archive.capture_row() OWNER TO kotu;
      ALTER FUNCTION archive.forbid_change() OWNER TO kotu;
    `);
    expect(await check("kotu")).toEqual([]);
  });

  test("суперпользователь + нет таблицы → строка про таблицу есть", async () => {
    await db.pg.exec(`DROP TABLE lecture_sources`);
    expect(await check("postgres")).toEqual(["public.lecture_sources (таблицы нет)"]);
    expect(await check("kotu")).toEqual(["public.lecture_sources (таблицы нет)"]);
  });

  test("роли нет — строка есть всегда", async () => {
    const lines = await check("nobody");
    expect(lines).toContain("роли nobody в базе нет");
    expect(lines).toContain("public.lecture_sources (таблицы нет)");
  });
});
