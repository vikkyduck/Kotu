/**
 * Архив строк — схема archive в той же базе kotu.
 *
 * Решение владелицы 23.09.2026: «стирать нельзя ничего». Кнопка «Удалить»
 * убирает вещь из рабочего пространства, а прежнее содержимое остаётся здесь.
 * Архив только пополняется: кода, который из него удаляет, нет вообще, а
 * таблицы архива дополнительно закрыты триггером append_only — стереть из
 * архива может только владелица вручную, сняв этот триггер.
 *
 * Почему триггеры в базе, а не вызовы в коде: код забудет, триггер — нет.
 * Каскадное удаление по FK (лекция → главы → источники, колода → слайды →
 * картинки) не проходит через наш код вовсе, а row-level триггеры на
 * дочерних таблицах срабатывают и там.
 *
 * Почему схема archive, а не public: drizzle-kit push управляет только
 * public и предложил бы DROP незнакомых ему таблиц.
 *
 * Модуль без зависимостей от пула и путей: тот же текст SQL гоняют тесты
 * на настоящем Postgres (PGlite) — проверяется ровно то, что уедет в прод.
 */

export type Query = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

/** Кто умеет выполнить функцию в одной транзакции: пул pg в проде, PGlite в тестах. */
export interface SqlRunner {
  transaction<T>(fn: (q: Query) => Promise<T>): Promise<T>;
}

export interface ArchivedTable {
  table: string;
  /**
   * Служебные колонки: их изменение само по себе версию не создаёт.
   * Прогресс, сообщения очереди, статусы и производные счётчики меняются
   * десятки раз за задачу, а содержимого не несут.
   */
  service: string[];
  /**
   * Значения status, при которых строку пишет машина и текст ещё не готов.
   * Промежуточные версии такой строки в архив не идут — см. capture_row.
   */
  busy: string[];
}

/**
 * Что архивируем. НЕ архивируем: jobs (служебная очередь), doc_chunks
 * (производный поисковый индекс — пересобирается из файла), users, sessions,
 * password_resets (аутентификация).
 */
export const ARCHIVED_TABLES: readonly ArchivedTable[] = [
  {
    table: "transcriptions",
    service: ["status", "progress", "status_message", "error", "updated_at"],
    busy: ["processing"],
  },
  { table: "folders", service: [], busy: [] },
  {
    table: "documents",
    // pages и chunk_count пересчитывает разбор файла — это производное.
    service: ["status", "status_message", "error", "chunk_count", "pages"],
    busy: [],
  },
  {
    table: "decks",
    service: ["status", "status_message", "error", "updated_at"],
    busy: ["storyboarding", "drawing"],
  },
  // image_status — копия статуса картинки ради прогресса в списке слайдов.
  { table: "deck_slides", service: ["image_status"], busy: [] },
  { table: "deck_images", service: ["status", "error"], busy: ["drawing"] },
  { table: "style_packs", service: [], busy: [] },
  {
    table: "lectures",
    service: ["status", "status_message", "error", "updated_at"],
    busy: ["planning", "writing"],
  },
  { table: "lecture_sections", service: ["status"], busy: ["writing"] },
  { table: "lecture_sources", service: [], busy: [] },
];

export const TRIGGER_NAME = "kotu_archive";

/** Ключ pg_advisory_xact_lock: два одновременных старта не мешают друг другу. */
export const ARCHIVE_LOCK_KEY = 7310452001;

/**
 * Решение «сохранять ли прежнюю строку» принимает capture_row:
 *
 * DELETE — прежняя строка сохраняется ВСЕГДА, в том числе при каскаде по FK.
 *
 * UPDATE — прежняя строка (OLD) сохраняется, если изменилось содержимое,
 * то есть что-то кроме служебных колонок. Против раздувания архива, если
 * машина пишет текст по частям многократными UPDATE (сейчас главы и слайды
 * пишутся одним UPDATE, но правило не должно зависеть от этого):
 *   1. Если OLD «в работе» (status из busy) — это промежуточный вывод машины,
 *      его не храним. Готовая версия, которую затирает запись, сохранена
 *      правилом 2 в момент, когда строка ушла в работу.
 *   2. Строка переходит в работу (status входит в busy), даже если поменялся
 *      только статус, — сохраняем OLD как «последнюю готовую» версию: всё,
 *      что владелица видела готовым или правила руками, попадает в архив до
 *      того, как машина начнёт писать поверх.
 *   3. Если последняя архивная версия этой строки совпадает с OLD по
 *      содержимому — повтор не пишем: она уже сохранена (повторные уходы в
 *      работу без правок, откат к прежнему тексту).
 * Итог: на каждую перегенерацию — не больше одной версии, а не по версии на
 * каждый кусок текста.
 *
 * Упала вставка в архив — падает и сама операция: без архива не перезаписываем.
 */
const CAPTURE_FUNCTION = `
CREATE OR REPLACE FUNCTION archive.capture_row() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  service  text[] := TG_ARGV[0]::text[];
  busy     text[] := TG_ARGV[1]::text[];
  old_row  jsonb  := to_jsonb(OLD);
  new_row  jsonb;
  old_busy boolean;
  new_busy boolean;
  last_row jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO archive.rows (tbl, op, row_id, data)
    VALUES (TG_TABLE_NAME, 'DELETE', old_row->>'id', old_row);
    RETURN OLD;
  END IF;

  new_row  := to_jsonb(NEW);
  old_busy := coalesce(old_row->>'status' = ANY (busy), false);
  new_busy := coalesce(new_row->>'status' = ANY (busy), false);

  IF (old_row - service) = (new_row - service) THEN
    -- Изменились только служебные поля: версия нужна лишь на входе в работу.
    IF old_busy OR NOT new_busy THEN
      RETURN NEW;
    END IF;
  ELSIF old_busy THEN
    -- Промежуточный вывод машины.
    RETURN NEW;
  END IF;

  SELECT r.data INTO last_row
    FROM archive.rows r
   WHERE r.tbl = TG_TABLE_NAME AND r.row_id = old_row->>'id'
   ORDER BY r.at DESC, r.id DESC
   LIMIT 1;
  IF last_row IS NOT NULL AND (last_row - service) = (old_row - service) THEN
    RETURN NEW;
  END IF;

  INSERT INTO archive.rows (tbl, op, row_id, data)
  VALUES (TG_TABLE_NAME, 'UPDATE', old_row->>'id', old_row);
  RETURN NEW;
END
$fn$`;

/** Архив только пополняется: UPDATE, DELETE и TRUNCATE его таблиц запрещены. */
const FORBID_FUNCTION = `
CREATE OR REPLACE FUNCTION archive.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'archive.%: архив только пополняется, % запрещён', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$fn$`;

const APPEND_ONLY_TABLES = ["rows", "files", "file_events"] as const;

/**
 * Таблицы и функции архива. Всё идемпотентно: выполняется на каждом старте.
 *
 * op в archive.rows: UPDATE и DELETE пишет триггер, INITIAL — первичный
 * снимок, INPUT — то, что пользовательница дала на вход и что больше нигде
 * в базе не лежит (вставленный текст презентации).
 *
 * archive.file_seen — не архив, а кэш сверки файлов: путь, размер, mtime и
 * inode последнего заархивированного состояния, чтобы не хэшировать весь
 * диск каждые шесть часов.
 */
export const BASE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS archive.rows (
     id     bigserial PRIMARY KEY,
     at     timestamptz NOT NULL DEFAULT now(),
     tbl    text NOT NULL,
     op     text NOT NULL,
     row_id text,
     data   jsonb NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS rows_tbl_row_at_idx ON archive.rows (tbl, row_id, at)`,
  `CREATE TABLE IF NOT EXISTS archive.files (
     sha256      text PRIMARY KEY,
     size        bigint NOT NULL,
     stored_path text NOT NULL,
     first_seen  timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS archive.file_events (
     id            bigserial PRIMARY KEY,
     at            timestamptz DEFAULT now(),
     sha256        text NOT NULL REFERENCES archive.files (sha256),
     source_path   text,
     kind          text,
     entity_type   text,
     entity_id     integer,
     original_name text,
     mime          text
   )`,
  `CREATE INDEX IF NOT EXISTS file_events_entity_idx ON archive.file_events (entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS file_events_source_idx ON archive.file_events (source_path)`,
  `CREATE TABLE IF NOT EXISTS archive.file_seen (
     path     text PRIMARY KEY,
     size     bigint NOT NULL,
     mtime_ms double precision NOT NULL,
     ino      text NOT NULL,
     sha256   text NOT NULL,
     seen_at  timestamptz NOT NULL DEFAULT now()
   )`,
  FORBID_FUNCTION,
  ...APPEND_ONLY_TABLES.flatMap((t) => [
    `CREATE OR REPLACE TRIGGER append_only BEFORE UPDATE OR DELETE ON archive.${t}
       FOR EACH ROW EXECUTE FUNCTION archive.forbid_change()`,
    `CREATE OR REPLACE TRIGGER append_only_truncate BEFORE TRUNCATE ON archive.${t}
       FOR EACH STATEMENT EXECUTE FUNCTION archive.forbid_change()`,
  ]),
  CAPTURE_FUNCTION,
];

function ident(name: string): string {
  if (!/^[a-z_]+$/.test(name)) throw new Error(`Недопустимое имя в архиве: ${name}`);
  return name;
}

function pgArray(items: readonly string[]): string {
  return `{${items.map(ident).join(",")}}`;
}

export function triggerDdl(t: ArchivedTable): string {
  return `CREATE OR REPLACE TRIGGER ${TRIGGER_NAME}
    AFTER UPDATE OR DELETE ON public.${ident(t.table)}
    FOR EACH ROW EXECUTE FUNCTION archive.capture_row('${pgArray(t.service)}', '${pgArray(t.busy)}')`;
}

export function snapshotSql(t: ArchivedTable): string {
  const name = ident(t.table);
  return `WITH ins AS (
      INSERT INTO archive.rows (tbl, op, row_id, data)
      SELECT '${name}', 'INITIAL', s.id::text, to_jsonb(s) FROM public.${name} s ORDER BY s.id
      RETURNING 1
    ) SELECT count(*)::int AS n FROM ins`;
}

export interface EnsureResult {
  /** Таблицы, получившие первичный снимок на этом старте. */
  snapshotted: string[];
  /** Сколько строк ушло в первичные снимки. */
  initialRows: number;
}

/**
 * Включает архив строк. Идемпотентно и безопасно для двух стартов разом.
 *
 * Триггер ставится на КАЖДОМ старте (CREATE OR REPLACE): если drizzle push
 * когда-нибудь пересоздаст таблицу, триггер пропадёт вместе с ней, и
 * следующий старт вернёт его. Первичный снимок (op='INITIAL') делается в той
 * же транзакции, что и установка триггера, и только когда действующего
 * триггера не было: CREATE TRIGGER держит блокировку таблицы до COMMIT,
 * поэтому между снимком и триггером ни одна запись не проскочит, а повторный
 * старт при живом триггере снимок не дублирует.
 */
export async function ensureArchiveWith(runner: SqlRunner): Promise<EnsureResult> {
  await runner.transaction(async (q) => {
    await q(`SELECT pg_advisory_xact_lock(${ARCHIVE_LOCK_KEY})`);
    // Схему заранее создаёт deploy.sh от postgres с владельцем-приложением:
    // права CREATE на базу у приложения может не быть, а CREATE SCHEMA
    // IF NOT EXISTS проверяет это право даже для существующей схемы.
    const schema = await q(`SELECT 1 FROM pg_namespace WHERE nspname = 'archive'`);
    if (schema.rows.length === 0) await q(`CREATE SCHEMA IF NOT EXISTS archive`);
    for (const stmt of BASE_DDL) await q(stmt);
  });

  const result: EnsureResult = { snapshotted: [], initialRows: 0 };
  for (const t of ARCHIVED_TABLES) {
    await runner.transaction(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(${ARCHIVE_LOCK_KEY})`);
      const qualified = `public.${ident(t.table)}`;
      const reg = await q(`SELECT to_regclass($1)::text AS reg`, [qualified]);
      if (!reg.rows[0]?.["reg"]) {
        throw new Error(`Архив: нет таблицы ${qualified} — не на что ставить триггер`);
      }
      const active = await q(
        `SELECT 1 FROM pg_trigger
          WHERE tgrelid = $1::regclass AND tgname = $2 AND tgenabled <> 'D'`,
        [qualified, TRIGGER_NAME],
      );
      await q(triggerDdl(t));
      if (active.rows.length === 0) {
        const n = await q(snapshotSql(t));
        result.snapshotted.push(t.table);
        result.initialRows += Number(n.rows[0]?.["n"] ?? 0);
      }
    });
  }
  return result;
}
