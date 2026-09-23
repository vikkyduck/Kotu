import { test, describe, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIVED_TABLES, ensureArchiveWith } from "./archive-sql";
import { createTestDb, type TestDb } from "./archive-test-db";

/**
 * Проверка владельцев из deploy.sh (шаг 4) — тот самый текст SQL из
 * скрипта, на настоящем Postgres (PGlite). psql-переменную :'u' подставляем
 * так же, как psql: строковым литералом.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** Текст первого блока <<'SQL' … SQL из файла репозитория. */
function sqlBlock(file: string): string {
  const text = readFileSync(path.resolve(here, "../../../..", file), "utf8");
  const match = /<<'SQL'\n([\s\S]*?)\nSQL\n/.exec(text);
  if (!match) throw new Error(`В ${file} не нашёл блок <<'SQL' … SQL`);
  return match[1]!;
}

const OWNER_CHECK = sqlBlock("deploy.sh");
/** Передача владельцев после pg_restore — рецепт из runbook восстановления. */
const RESTORE_OWNERS = sqlBlock("ops/ВОССТАНОВЛЕНИЕ.md");

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
    // Список таблиц в deploy.sh — копия ARCHIVED_TABLES: разойдутся — тест упадёт.
    expect(lines.filter((l) => l.startsWith("public.")).sort()).toEqual(
      ARCHIVED_TABLES.map((t) => `public.${t.table} (владелец postgres)`).sort(),
    );
  });

  test("всё передано приложению по ops/ВОССТАНОВЛЕНИЕ.md — чисто", async () => {
    await db.pg.exec(RESTORE_OWNERS);
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
