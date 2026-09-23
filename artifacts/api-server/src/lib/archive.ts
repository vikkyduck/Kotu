import type { RequestHandler } from "express";
import { sql, type SQL } from "drizzle-orm";
import { pool } from "@workspace/db";
import { ARCHIVE_DIR, DATA_DIRS } from "./paths";
import { ensureArchiveWith, type SqlRunner } from "./archive-sql";
import { createFileArchive, ArchiveUnavailableError, type FileMeta } from "./archive-files";
import { logger } from "./logger";

/**
 * Архив «всего» для этого процесса: строки (триггеры в базе, archive-sql.ts)
 * и файлы (хранилище по содержимому, archive-files.ts).
 *
 * Состояние видно в GET /api/healthz: archive "ok" | "off" | "pending".
 * "off" — архив не включился: сервер отвечает (прод не кладём), но работает
 * только на чтение — очередь задач стоит, изменения и удаления отклоняются
 * (routes/index.ts), а включить архив он пробует снова раз в минуту.
 * deploy.sh такую выкатку бракует.
 */

export type ArchiveState = "pending" | "ok" | "off";

let state: ArchiveState = "pending";
/** Последняя попытка включить архив; её итог — и есть ответ ready(). */
let attempt: Promise<ArchiveState> | null = null;

/** Пауза между попытками включить архив, пока он выключен. */
const RETRY_MS = 60_000;

const poolRunner: SqlRunner = {
  async transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn((text, params) => client.query(text, params));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  },
};

async function tryEnsure(): Promise<ArchiveState> {
  try {
    const r = await ensureArchiveWith(poolRunner);
    state = "ok";
    logger.info(
      { snapshotted: r.snapshotted, initialRows: r.initialRows },
      "Архив включён: триггеры на месте",
    );
  } catch (err) {
    state = "off";
    logger.error(
      { err },
      "АРХИВ НЕ ВКЛЮЧИЛСЯ — сервер только на чтение: очередь стоит, изменения отклоняются. Повтор через минуту",
    );
  }
  return state;
}

/**
 * Первая попытка включить архив строк. Не бросает: итог — в archiveState()
 * и в логе.
 */
export function ensureArchive(): Promise<ArchiveState> {
  attempt ??= tryEnsure();
  return attempt;
}

let readyLoop: Promise<void> | null = null;

/**
 * Разрешается, когда архив включён: не вышло с первого раза — пробует раз в
 * минуту, пока не выйдет. Всё, что меняет данные без участия человека
 * (очередь, стартовые сверки), запускается только после него: без
 * триггеров архива перезапись шла бы мимо него.
 */
export function whenArchiveReady(): Promise<void> {
  readyLoop ??= new Promise((resolve) => {
    const check = (s: ArchiveState) => {
      if (s === "ok") {
        resolve();
        return;
      }
      setTimeout(() => {
        attempt = tryEnsure();
        void attempt.then(check);
      }, RETRY_MS);
    };
    void ensureArchive().then(check);
  });
  return readyLoop;
}

export function archiveState(): ArchiveState {
  return state;
}

async function ready(): Promise<boolean> {
  await ensureArchive();
  // Идёт повторная попытка — ждём её итога, а не прошлого «off».
  return (await attempt!) === "ok";
}

/**
 * Проверка в начале пользовательских удалений: без архива не удаляем
 * ничего, в том числе строки, — иначе они ушли бы мимо триггеров.
 */
export async function requireArchive(): Promise<void> {
  if (!(await ready())) throw new ArchiveUnavailableError();
}

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Пока архив не включён, сервер только на чтение: правка расшифровки или
 * главы лекции без триггера затёрла бы прежний текст насовсем. Ставится
 * после входа — сам вход и сброс пароля архива не касаются.
 */
export const rejectWritesWithoutArchive: RequestHandler = (req, res, next) => {
  if (READ_ONLY.has(req.method) || state === "ok") {
    next();
    return;
  }
  req.log.warn({ archive: state }, "Изменение отклонено: архив не включён");
  const message = "Архив сейчас недоступен, поэтому изменения не сохраняются. Попробуйте позже";
  res.status(503).json({ message, error: message });
};

const files = createFileArchive({
  archiveDir: ARCHIVE_DIR,
  dataDirs: DATA_DIRS,
  query: (text, params) => pool.query(text, params),
  ready,
  log: logger,
});

export const archiveFile = files.archiveFile;
export const archiveAndRemove = files.archiveAndRemove;
export const archiveTreeAndRemove = files.archiveTreeAndRemove;
export const writeDataFile = files.writeDataFile;

/**
 * Заархивировать только что загруженный файл. Сбой не роняет загрузку:
 * файл лежит на месте, и его подберёт сверка.
 */
export async function archiveUpload(filePath: string, meta: Omit<FileMeta, "kind">): Promise<void> {
  await files
    .archiveFile(filePath, { ...meta, kind: "upload" })
    .catch((err) => logger.error({ err, ...meta }, "Не смог заархивировать загрузку — догонит сверка"));
}

/**
 * То, что пользовательница дала на вход и что в рабочих таблицах не
 * хранится (вставленный текст презентации живёт только в задаче очереди).
 * Для drizzle-транзакции: вход и сама сущность появляются вместе или никак.
 * Тот же вход второй раз не пишется.
 */
export function archiveInputSql(tbl: string, rowId: number, data: Record<string, unknown>): SQL {
  const json = JSON.stringify(data);
  return sql`INSERT INTO archive.rows (tbl, op, row_id, data)
    SELECT ${tbl}, 'INPUT', ${String(rowId)}, ${json}::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM archive.rows
       WHERE tbl = ${tbl} AND row_id = ${String(rowId)} AND op = 'INPUT' AND data = ${json}::jsonb
    )`;
}

const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

async function sweepOnce(): Promise<void> {
  if (!(await ready())) {
    logger.warn("Архив выключен — сверку файлов пропускаю");
    return;
  }
  const r = await files.sweep();
  if (r.archived > 0 || r.failed > 0) logger.info(r, "Сверка файлов с архивом");
}

/** Сверка файлов на старте и потом каждые шесть часов. */
export function startFileSweep(): void {
  void sweepOnce().catch((err) => logger.error({ err }, "Сверка файлов с архивом не удалась"));
  setInterval(() => {
    void sweepOnce().catch((err) => logger.error({ err }, "Сверка файлов с архивом не удалась"));
  }, SWEEP_EVERY_MS).unref();
}

export { ArchiveUnavailableError };
