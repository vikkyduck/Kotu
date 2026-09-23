import { test, describe, expect, beforeAll } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@workspace/db/schema";
import { ARCHIVED_TABLES, TRIGGER_NAME, ensureArchiveWith } from "./archive-sql";
import { createTestDb, type TestDb } from "./archive-test-db";

/**
 * Архив строк на настоящем Postgres (PGlite): тот же SQL, что ставит
 * ensureArchive на проде, — не копия. Проверяем обещания владелице:
 * правка не затирает прежнее, удаление (и каскад) не стирает, служебные
 * поля и потоковая запись не раздувают архив.
 */

type Row = Record<string, unknown>;

async function archived(db: TestDb, tbl: string, rowId?: number | string): Promise<Row[]> {
  const { rows } = await db.query(
    rowId === undefined
      ? `SELECT op, row_id, data FROM archive.rows WHERE tbl = $1 ORDER BY id`
      : `SELECT op, row_id, data FROM archive.rows WHERE tbl = $1 AND row_id = $2 ORDER BY id`,
    rowId === undefined ? [tbl] : [tbl, String(rowId)],
  );
  return rows;
}

async function count(db: TestDb, where = "true"): Promise<number> {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM archive.rows WHERE ${where}`);
  return Number(rows[0]!["n"]);
}

async function seed(db: TestDb): Promise<void> {
  await db.pg.exec(`
    INSERT INTO users (email) VALUES ('kot@example.ru');
    INSERT INTO folders (owner_id, name) VALUES (1, 'Фрейд');
    INSERT INTO transcriptions (owner_id, title, filename, segments)
      VALUES (1, 'Сеанс 1', 'a.m4a', '[{"who":"А","text":"первый текст"}]');
    INSERT INTO documents (owner_id, folder_id, title, source_path, mime, status)
      VALUES (1, 1, 'Толкование сновидений', '/opt/kotu/library/1.pdf', 'application/pdf', 'ready');
    INSERT INTO doc_chunks (document_id, ord, text) VALUES (1, 0, 'фрагмент');
    INSERT INTO style_packs (owner_id, name, prompt_suffix) VALUES (NULL, 'Архивный сон', 'etching');
    INSERT INTO lectures (owner_id, title, brief, status) VALUES (1, 'Вытеснение', '{"topic":"вытеснение"}', 'ready');
    INSERT INTO lecture_sections (lecture_id, ord, heading, text, status)
      VALUES (1, 0, 'Глава 1', 'готовый текст', 'ready'), (1, 1, 'Глава 2', 'второй', 'ready');
    INSERT INTO lecture_sources (lecture_id, section_id, title, quote)
      VALUES (1, 1, 'Фрейд', 'цитата'), (1, 2, 'Лакан', 'цитата 2');
    INSERT INTO decks (owner_id, title, source_kind, status) VALUES (1, 'Колода', 'raw', 'ready');
    INSERT INTO deck_slides (deck_id, ord, content) VALUES (1, 0, '{"title":"Обложка"}'), (1, 1, '{"title":"Второй"}');
    INSERT INTO deck_images (deck_id, slide_id, path, status) VALUES (1, 1, '/opt/kotu/decks/1/1.png', 'ready');
  `);
}

describe("архив строк", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await seed(db);
    await ensureArchiveWith(db.runner);
  }, 60_000);

  test("колонки тестовых таблиц и служебные поля совпадают со схемой drizzle", () => {
    const byName = new Map<string, string[]>();
    for (const value of Object.values(schema)) {
      if (value && typeof value === "object" && Symbol.for("drizzle:IsDrizzleTable") in value) {
        const cfg = getTableConfig(value as PgTable);
        byName.set(cfg.name, cfg.columns.map((c) => c.name));
      }
    }
    for (const t of ARCHIVED_TABLES) {
      const cols = byName.get(t.table);
      expect(cols, t.table).toBeDefined();
      for (const s of t.service) expect(cols, `${t.table}.${s}`).toContain(s);
      if (t.busy.length > 0) expect(cols, `${t.table}.status`).toContain("status");
    }
  });

  test("тестовый DDL повторяет колонки схемы drizzle", async () => {
    for (const value of Object.values(schema)) {
      if (!(value && typeof value === "object" && Symbol.for("drizzle:IsDrizzleTable") in value)) continue;
      const cfg = getTableConfig(value as PgTable);
      if (!ARCHIVED_TABLES.some((t) => t.table === cfg.name)) continue;
      const { rows } = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [cfg.name],
      );
      expect(rows.map((r) => r["column_name"]).sort(), cfg.name).toEqual(
        cfg.columns.map((c) => c.name).sort(),
      );
    }
  });

  test("(д) первичный снимок содержит все строки каждой таблицы", async () => {
    for (const t of ARCHIVED_TABLES) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.${t.table}`);
      const n = Number(rows[0]!["n"]);
      expect(n, t.table).toBeGreaterThan(0);
      expect(await count(db, `tbl = '${t.table}' AND op = 'INITIAL'`), t.table).toBe(n);
    }
    const [first] = await archived(db, "transcriptions", 1);
    expect(first!["data"]).toMatchObject({ title: "Сеанс 1", filename: "a.m4a" });
  });

  test("(г) повторный ensureArchive не дублирует снимок и не падает", async () => {
    const before = await count(db);
    const r = await ensureArchiveWith(db.runner);
    expect(r.snapshotted).toEqual([]);
    expect(await count(db)).toBe(before);
  });

  test("(а) правка содержимого сохраняет прежнее значение", async () => {
    const segs = async () =>
      (await archived(db, "transcriptions", 1)).map((r) => [r["op"], (r["data"] as Row)["segments"]]);

    // Первая правка: исходный текст уже лежит в первичном снимке — повтор не нужен.
    await db.query(`UPDATE transcriptions SET segments = '[{"who":"А","text":"правка"}]' WHERE id = 1`);
    expect(await segs()).toEqual([["INITIAL", [{ who: "А", text: "первый текст" }]]]);

    // Вторая правка: первая правка — в архиве отдельной версией.
    await db.query(`UPDATE transcriptions SET segments = '[{"who":"А","text":"ещё правка"}]' WHERE id = 1`);
    expect(await segs()).toEqual([
      ["INITIAL", [{ who: "А", text: "первый текст" }]],
      ["UPDATE", [{ who: "А", text: "правка" }]],
    ]);

    await db.query(`UPDATE folders SET name = 'Фрейд и Лакан' WHERE id = 1`);
    await db.query(`UPDATE folders SET name = 'Фрейд, Лакан, Кляйн' WHERE id = 1`);
    const names = (await archived(db, "folders", 1)).map((r) => (r["data"] as Row)["name"]);
    expect(names).toEqual(["Фрейд", "Фрейд и Лакан"]);
  });

  test("(б) правка только служебных полей версию не создаёт", async () => {
    const before = await count(db);
    await db.query(
      `UPDATE transcriptions SET progress = 50, status_message = 'Режу', updated_at = now() WHERE id = 1`,
    );
    await db.query(`UPDATE documents SET status = 'parsing', status_message = 'Читаю', chunk_count = 7, pages = 3 WHERE id = 1`);
    await db.query(`UPDATE deck_slides SET image_status = 'queued' WHERE id = 1`);
    // Совсем пустое обновление — тоже не версия.
    await db.query(`UPDATE folders SET name = name WHERE id = 1`);
    expect(await count(db)).toBe(before);
  });

  test("(в) удаление родителя сохраняет и детей каскада", async () => {
    await db.query(`DELETE FROM lectures WHERE id = 1`);
    expect((await archived(db, "lectures", 1)).at(-1)!["op"]).toBe("DELETE");
    const sections = (await archived(db, "lecture_sections")).filter((r) => r["op"] === "DELETE");
    expect(sections.map((r) => (r["data"] as Row)["text"]).sort()).toEqual(["второй", "готовый текст"]);
    const sources = (await archived(db, "lecture_sources")).filter((r) => r["op"] === "DELETE");
    expect(sources).toHaveLength(2);

    await db.query(`DELETE FROM decks WHERE id = 1`);
    expect((await archived(db, "deck_slides")).filter((r) => r["op"] === "DELETE")).toHaveLength(2);
    const images = (await archived(db, "deck_images")).filter((r) => r["op"] === "DELETE");
    expect(images).toHaveLength(1);
    expect(images[0]!["data"]).toMatchObject({ path: "/opt/kotu/decks/1/1.png" });

    // Удаление пользователя каскадом уносит папки, документы, стили — всё в архив.
    await db.query(`DELETE FROM users WHERE id = 1`);
    expect((await archived(db, "documents", 1)).at(-1)!["op"]).toBe("DELETE");
    expect((await archived(db, "folders", 1)).at(-1)!["op"]).toBe("DELETE");
  });

  test("(е) потоковая запись текста не раздувает архив, но готовые версии сохраняются", async () => {
    await db.pg.exec(`
      INSERT INTO users (email) VALUES ('stream@example.ru');
      INSERT INTO lectures (owner_id, title, brief, status) VALUES (2, 'Поток', '{}', 'writing');
      INSERT INTO lecture_sections (lecture_id, ord, heading) VALUES (2, 0, 'Глава');
    `);
    const { rows } = await db.query(`SELECT id FROM lecture_sections WHERE lecture_id = 2`);
    const sid = Number(rows[0]!["id"]);
    const versions = async () => (await archived(db, "lecture_sections", sid)).length;

    // Машина берётся за главу и пишет её по кусочкам.
    await db.query(`UPDATE lecture_sections SET status = 'writing' WHERE id = $1`, [sid]);
    const atStart = await versions();
    let text = "";
    for (const piece of ["Вытеснение ", "не уничтожает ", "содержание, ", "оно возвращается."]) {
      text += piece;
      await db.query(`UPDATE lecture_sections SET text = $2 WHERE id = $1`, [sid, text]);
    }
    await db.query(`UPDATE lecture_sections SET text = $2, status = 'ready' WHERE id = $1`, [sid, text]);
    // Промежуточные куски — ни одной версии.
    expect(await versions()).toBe(atStart);

    // Владелица правит готовую главу — готовый машинный текст сохраняется.
    await db.query(
      `UPDATE lecture_sections SET text = 'Моя правка', edited_by_human = true WHERE id = $1`,
      [sid],
    );
    const afterEdit = await archived(db, "lecture_sections", sid);
    expect(afterEdit).toHaveLength(atStart + 1);
    expect((afterEdit.at(-1)!["data"] as Row)["text"]).toBe(text);

    // Перегенерация поверх правки: правка уходит в архив в момент ухода в работу,
    // дальше — снова ни одной промежуточной версии.
    await db.query(`UPDATE lecture_sections SET status = 'writing' WHERE id = $1`, [sid]);
    for (const t of ["Н", "Но", "Новый"]) {
      await db.query(`UPDATE lecture_sections SET text = $2 WHERE id = $1`, [sid, t]);
    }
    await db.query(`UPDATE lecture_sections SET status = 'ready' WHERE id = $1`, [sid]);
    const all = await archived(db, "lecture_sections", sid);
    expect(all).toHaveLength(atStart + 2);
    expect((all.at(-1)!["data"] as Row)["text"]).toBe("Моя правка");

    // Повторный уход в работу без правок не плодит одинаковых версий.
    await db.query(`UPDATE lecture_sections SET status = 'writing' WHERE id = $1`, [sid]);
    await db.query(`UPDATE lecture_sections SET status = 'ready' WHERE id = $1`, [sid]);
    await db.query(`UPDATE lecture_sections SET status = 'writing' WHERE id = $1`, [sid]);
    await db.query(`UPDATE lecture_sections SET status = 'ready' WHERE id = $1`, [sid]);
    expect(await versions()).toBe(atStart + 3);
    await db.query(`UPDATE lecture_sections SET status = 'writing' WHERE id = $1`, [sid]);
    await db.query(`UPDATE lecture_sections SET status = 'ready' WHERE id = $1`, [sid]);
    expect(await versions()).toBe(atStart + 3);
  });

  test("без архива не перезаписываем: упала вставка — упала и правка", async () => {
    await db.pg.exec(`
      INSERT INTO transcriptions (owner_id, title, filename) VALUES (2, 'Хрупкая', 'b.m4a');
      ALTER TABLE archive.rows ADD CONSTRAINT test_block CHECK (false) NOT VALID;
    `);
    await expect(
      db.query(`UPDATE transcriptions SET title = 'Новая' WHERE title = 'Хрупкая'`),
    ).rejects.toThrow();
    await expect(db.query(`DELETE FROM transcriptions WHERE title = 'Хрупкая'`)).rejects.toThrow();
    await db.pg.exec(`ALTER TABLE archive.rows DROP CONSTRAINT test_block`);
    const { rows } = await db.query(`SELECT title FROM transcriptions WHERE title = 'Хрупкая'`);
    expect(rows).toHaveLength(1);
  });

  test("архив только пополняется: UPDATE, DELETE и TRUNCATE запрещены", async () => {
    await expect(db.query(`DELETE FROM archive.rows`)).rejects.toThrow(/только пополняется/);
    await expect(db.query(`UPDATE archive.rows SET data = '{}'`)).rejects.toThrow(/только пополняется/);
    await expect(db.query(`TRUNCATE archive.rows`)).rejects.toThrow(/только пополняется/);
  });

  test("пропавший триггер возвращается на следующем старте со свежим снимком", async () => {
    await db.pg.exec(`DROP TRIGGER ${TRIGGER_NAME} ON folders`);
    const r = await ensureArchiveWith(db.runner);
    expect(r.snapshotted).toEqual(["folders"]);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal`,
      [TRIGGER_NAME],
    );
    expect(Number(rows[0]!["n"])).toBe(ARCHIVED_TABLES.length);
  });

  test("рецепт возврата удалённой строки из ГДЕ-ЧТО.md работает", async () => {
    await db.pg.exec(`
      INSERT INTO users (email) VALUES ('restore@example.ru');
      INSERT INTO lectures (owner_id, title, brief, plan)
        VALUES (3, 'Работа горя', '{"topic":"горе"}', '[{"heading":"Утрата"}]');
    `);
    const { rows: made } = await db.query(`SELECT id FROM lectures WHERE title = 'Работа горя'`);
    const id = Number(made[0]!["id"]);
    await db.query(`DELETE FROM lectures WHERE id = $1`, [id]);
    const { rows: found } = await db.query(
      `SELECT id FROM archive.rows WHERE tbl = 'lectures' AND op = 'DELETE' AND data->>'title' ILIKE '%горя%'`,
    );
    const n = Number(found[0]!["id"]);
    await db.query(
      `INSERT INTO public.lectures SELECT * FROM jsonb_populate_record(null::public.lectures, (SELECT data FROM archive.rows WHERE id = ${n}))`,
    );
    const { rows: back } = await db.query(`SELECT id, title, plan FROM lectures WHERE id = $1`, [id]);
    expect(back[0]).toMatchObject({ id, title: "Работа горя", plan: [{ heading: "Утрата" }] });
  });

  test("не архивируем служебное: jobs нет, doc_chunks нет", async () => {
    expect(await count(db, `tbl IN ('doc_chunks', 'users', 'jobs', 'sessions')`)).toBe(0);
  });
});
