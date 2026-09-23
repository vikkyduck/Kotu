import { PGlite } from "@electric-sql/pglite";
import type { Query, SqlRunner } from "./archive-sql";

/**
 * Настоящий Postgres для тестов архива — PGlite (Postgres в WASM, с plpgsql).
 * Только для тестов: в бандл сервера не попадает (index.ts его не импортирует).
 *
 * Таблицы — упрощённый DDL с теми же именами, колонками и внешними ключами,
 * что в схеме drizzle (lib/db/src/schema). Совпадение колонок проверяет
 * тест в archive-sql.test.ts: разъедется схема — упадёт он, а не прод.
 */
export const FIXTURE_DDL = `
CREATE TABLE users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'owner',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE transcriptions (
  id serial PRIMARY KEY,
  owner_id integer NOT NULL,
  title text NOT NULL,
  filename text NOT NULL,
  hide_names boolean NOT NULL DEFAULT false,
  mark_speakers boolean NOT NULL DEFAULT false,
  segments jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'done',
  progress integer NOT NULL DEFAULT 100,
  status_message text NOT NULL DEFAULT '',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE folders (
  id serial PRIMARY KEY,
  owner_id integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE documents (
  id serial PRIMARY KEY,
  owner_id integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  folder_id integer REFERENCES folders (id) ON DELETE SET NULL,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'book',
  transcription_id integer,
  deck_id integer,
  lecture_id integer,
  source_path text NOT NULL,
  mime text NOT NULL,
  pages integer,
  chunk_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'uploaded',
  status_message text NOT NULL DEFAULT '',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE doc_chunks (
  id bigserial PRIMARY KEY,
  document_id integer NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ord integer NOT NULL,
  page integer,
  heading text,
  text text NOT NULL
);
CREATE TABLE lectures (
  id serial PRIMARY KEY,
  owner_id integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title text NOT NULL,
  folder_id integer,
  brief jsonb NOT NULL,
  plan jsonb,
  plan_notes jsonb,
  bibliography jsonb,
  plan_approved boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'planning',
  status_message text NOT NULL DEFAULT '',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lecture_sections (
  id serial PRIMARY KEY,
  lecture_id integer NOT NULL REFERENCES lectures (id) ON DELETE CASCADE,
  ord integer NOT NULL,
  heading text NOT NULL,
  abstract text NOT NULL DEFAULT '',
  text text NOT NULL DEFAULT '',
  edited_by_human boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending'
);
CREATE TABLE lecture_sources (
  id serial PRIMARY KEY,
  lecture_id integer NOT NULL REFERENCES lectures (id) ON DELETE CASCADE,
  section_id integer REFERENCES lecture_sections (id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'doc',
  chunk_id integer,
  url text,
  title text NOT NULL,
  quote text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE decks (
  id serial PRIMARY KEY,
  owner_id integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title text NOT NULL,
  folder_id integer,
  source_kind text NOT NULL,
  source_id integer,
  style_pack_id integer,
  storyboard_approved boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'storyboarding',
  status_message text NOT NULL DEFAULT '',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE deck_slides (
  id serial PRIMARY KEY,
  deck_id integer NOT NULL REFERENCES decks (id) ON DELETE CASCADE,
  ord integer NOT NULL,
  layout text NOT NULL DEFAULT 'theory',
  content jsonb NOT NULL,
  notes text NOT NULL DEFAULT '',
  image_brief text,
  image_side text NOT NULL DEFAULT 'right',
  image_id integer,
  image_status text NOT NULL DEFAULT 'none',
  diagram_spec jsonb
);
CREATE TABLE deck_images (
  id serial PRIMARY KEY,
  deck_id integer NOT NULL REFERENCES decks (id) ON DELETE CASCADE,
  slide_id integer NOT NULL REFERENCES deck_slides (id) ON DELETE CASCADE,
  attempt integer NOT NULL DEFAULT 1,
  scene text NOT NULL DEFAULT '',
  prompt text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT 'gemini',
  model text NOT NULL DEFAULT '',
  path text,
  status text NOT NULL DEFAULT 'drawing',
  verdict text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE style_packs (
  id serial PRIMARY KEY,
  owner_id integer REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  prompt_suffix text NOT NULL,
  negative text NOT NULL DEFAULT '',
  palette jsonb NOT NULL DEFAULT '{}',
  typography jsonb,
  rules jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

export interface TestDb {
  pg: PGlite;
  query: Query;
  runner: SqlRunner;
}

/** Пустая база с таблицами приложения (без архива — его ставит ensureArchiveWith). */
export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.exec(FIXTURE_DDL);
  const query: Query = async (text, params) => {
    const r = await pg.query<Record<string, unknown>>(text, params as unknown[] | undefined);
    return { rows: r.rows };
  };
  const runner: SqlRunner = {
    transaction: (fn) =>
      pg.transaction((tx) =>
        fn(async (text, params) => {
          const r = await tx.query<Record<string, unknown>>(text, params as unknown[] | undefined);
          return { rows: r.rows };
        }),
      ),
  };
  return { pg, query, runner };
}
