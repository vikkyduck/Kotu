import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Защита от SQL-инъекций - параметры запросов, а не вырезание слов из текста
 * (lib/clean-text.ts объясняет почему). Все запросы идут через Drizzle: значение
 * в sql`… ${x} …` уходит в базу отдельным параметром и командой стать не может.
 *
 * Этот тест падает, если в коде появится запрос, собранный склейкой строк:
 * - sql.raw(…) - вставка готового текста в SQL. Разрешена только в
 *   lib/archive-sql.ts: там склеиваются константы, а значения идут параметрами
 *   (archive-sql.test.ts это проверяет);
 * - .query(`… ${x} …`), .unsafe(…) или .execute(`…`) без метки sql -
 *   строка с подставленным значением вместо параметра;
 * - .query("…" + x) - то же склейкой.
 *
 * deploy.sh гоняет тесты перед выкладкой, так что такая находка её останавливает.
 */

const RAW_ALLOWED = new Set(["artifacts/api-server/src/lib/archive-sql.ts"]);

const RULES: [string, RegExp][] = [
  ["sql.raw - текст вставляется в SQL как есть", /\bsql\.raw\s*\(/],
  ["запрос из шаблонной строки с подстановкой", /\.(?:query|unsafe)\s*\(\s*`[^`]*\$\{/],
  ["execute без метки sql", /\.execute\s*\(\s*`/],
  ["unsafe-запрос", /\.unsafe\s*\(/],
  ["запрос, склеенный плюсом", /\.query\s*\(\s*(?:"[^"]*"|'[^']*'|`[^`]*`)\s*\+/],
];

function sourceFiles(): { root: string; files: string[] } | null {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const files = execFileSync("git", ["-c", "core.quotepath=off", "ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter((f) => /\.(?:ts|tsx|mts|cts|js|mjs)$/.test(f) && !/\.test\.|\/dist\//.test(f));
    return { root, files };
  } catch {
    return null;
  }
}

const repo = sourceFiles();

describe.skipIf(repo === null)("SQL только с параметрами", () => {
  test("нет запросов, собранных склейкой строк", () => {
    const found: string[] = [];
    for (const file of repo!.files) {
      let text: string;
      try {
        text = readFileSync(path.join(repo!.root, file), "utf8");
      } catch {
        continue;
      }
      text.split("\n").forEach((line, i) => {
        for (const [kind, rx] of RULES) {
          if (!rx.test(line)) continue;
          if (kind.startsWith("sql.raw") && RAW_ALLOWED.has(file)) continue;
          found.push(`${file}:${i + 1}: ${kind}`);
        }
      });
    }
    expect(found).toEqual([]);
  });

  test("правила ловят то, что должны", () => {
    const hit = (line: string) => RULES.some(([, rx]) => rx.test(line));
    expect(hit("sql`AND id IN (${sql.raw(ids.join(','))})`")).toBe(true);
    expect(hit("await client.query(`SELECT * FROM t WHERE id = ${id}`)")).toBe(true);
    expect(hit('await pool.query("SELECT * FROM t WHERE name = \'" + name + "\'")')).toBe(true);
    expect(hit("await db.execute(`DELETE FROM t`)")).toBe(true);
    expect(hit("await db.execute(sql`DELETE FROM t WHERE id = ${id}`)")).toBe(false);
    expect(hit("await client.query(text, params)")).toBe(false);
    expect(hit('await client.query("BEGIN")')).toBe(false);
  });
});
