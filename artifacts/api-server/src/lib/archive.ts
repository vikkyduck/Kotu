import { sql, type SQL } from "drizzle-orm";
import { pool } from "@workspace/db";
import { ARCHIVE_DIR, DATA_DIRS } from "./paths";
import { ensureArchiveWith, findMissingTriggers, type SqlRunner } from "./archive-sql";
import { createArchiveSupervisor, type ArchiveState } from "./archive-state";
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
 *
 * «ok» перепроверяется: при старте и в периодической сверке (раз в 6 ч)
 * процесс смотрит в pg_trigger, на месте ли триггеры всех 10 таблиц, и если
 * нет — снова только чтение, пока не поставит их (archive-state.ts).
 */

export type { ArchiveState };

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

const supervisor = createArchiveSupervisor({
  ensure: () => ensureArchiveWith(poolRunner),
  missingTriggers: () => findMissingTriggers((text, params) => pool.query(text, params)),
  log: logger,
});

/** Первая попытка включить архив строк. Не бросает: итог — в archiveState() и в логе. */
export const ensureArchive = supervisor.ensureArchive;
/** Разрешается, когда архив включён (повтор раз в минуту). См. archive-state.ts. */
export const whenArchiveReady = supervisor.whenArchiveReady;
export const archiveState = supervisor.state;
export const requireArchive = supervisor.requireArchive;
export const rejectWritesWithoutArchive = supervisor.rejectWritesWithoutArchive;
const ready = supervisor.ready;

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
  // Сначала — на месте ли сами триггеры: без них сверка файлов бессмысленна,
  // а правки шли бы мимо архива.
  await supervisor.verify();
  if (!(await ready())) {
    logger.warn("Архив выключен — сверку файлов пропускаю");
    return;
  }
  const r = await files.sweep();
  if (r.archived > 0 || r.failed > 0) logger.info(r, "Сверка файлов с архивом");
}

/** Самопроверка триггеров и сверка файлов — на старте и потом каждые шесть часов. */
export function startFileSweep(): void {
  void sweepOnce().catch((err) => logger.error({ err }, "Сверка файлов с архивом не удалась"));
  setInterval(() => {
    void sweepOnce().catch((err) => logger.error({ err }, "Сверка файлов с архивом не удалась"));
  }, SWEEP_EVERY_MS).unref();
}

export { ArchiveUnavailableError };
export { deleteJobsArchivingInput } from "./archive-sql";
