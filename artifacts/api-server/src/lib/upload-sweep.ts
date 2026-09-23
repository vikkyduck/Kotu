import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  jobsTable,
  transcriptionsTable,
  type JobStatus,
  type TranscriptionStatus,
} from "@workspace/db";
import { UPLOAD_DIR } from "./paths";
import { logger } from "./logger";

/**
 * Сверка каталога загрузок. Аудио сеанса — зона А: после провала задачи оно
 * теперь остаётся на диске ради повтора, а значит, нужен кто-то, кто его
 * в итоге уберёт. Иначе запись сеанса лежала бы вечно (ФЗ-152, минимизация).
 */

/**
 * Файлы моложе суток не трогаем никогда: загрузка могла ещё идти (multer
 * пишет файл до того, как появится задача), и сверка не должна с ней гоняться.
 */
export const FRESH_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** Сколько аудио ждёт повтора после провала, прежде чем его уберут. */
export const ERROR_AUDIO_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

export interface UploadFile {
  path: string;
  mtimeMs: number;
}

/** Ссылка на аудио из задачи transcribe вместе с состоянием её записи. */
export interface UploadRef {
  inputPath: unknown;
  jobStatus: JobStatus;
  /** null — записи уже нет (удалили). */
  recordStatus: TranscriptionStatus | null;
  /** Когда запись окончательно упала; null — неизвестно (тогда храним). */
  failedAtMs: number | null;
}

/**
 * Абсолютный путь, если он лежит строго внутри каталога, иначе null. Путь из
 * payload приходит из базы — перед rm его нельзя принимать на веру: «../» или
 * чужой абсолютный путь не должны дотянуться до файлов вне загрузок.
 */
export function resolveInsideDir(dir: string, candidate: unknown): string | null {
  if (typeof candidate !== "string" || candidate === "") return null;
  const base = path.resolve(dir);
  const full = path.resolve(base, candidate);
  const rel = path.relative(base, full);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return full;
}

/**
 * Чистая часть сверки — какие файлы удалить. Файл нужен, пока на него
 * ссылается живая задача (в очереди или в работе) существующей записи, либо
 * проваленная задача записи, которую ещё можно повторить, — но не дольше
 * ERROR_AUDIO_KEEP_MS после провала. Готовой записи аудио уже не нужно:
 * текст есть, файл остался лишь потому, что не удалился после успеха.
 */
export function pickUploadsToSweep(
  dir: string,
  files: UploadFile[],
  refs: UploadRef[],
  nowMs: number,
): string[] {
  const keep = new Set<string>();
  for (const ref of refs) {
    const p = resolveInsideDir(dir, ref.inputPath);
    if (!p || ref.recordStatus === null) continue;
    if (ref.jobStatus === "queued" || ref.jobStatus === "running") {
      keep.add(p);
      continue;
    }
    if (ref.jobStatus === "error" && ref.recordStatus !== "done") {
      if (ref.failedAtMs === null || nowMs - ref.failedAtMs < ERROR_AUDIO_KEEP_MS) keep.add(p);
    }
  }

  const doomed: string[] = [];
  for (const file of files) {
    const p = resolveInsideDir(dir, file.path);
    if (!p) continue;
    if (nowMs - file.mtimeMs < FRESH_UPLOAD_MS) continue;
    if (keep.has(p)) continue;
    doomed.push(p);
  }
  return doomed;
}

/** Стартовая сверка: убрать из каталога загрузок аудио, которое никому не нужно. */
export async function sweepUploads(): Promise<number> {
  // Только файлы верхнего уровня: multer кладёт загрузки плоско, а каталоги
  // и ссылки там — не наши, их не трогаем.
  const entries = await readdir(UPLOAD_DIR, { withFileTypes: true }).catch(() => []);
  const files: UploadFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(UPLOAD_DIR, entry.name);
    const st = await lstat(full).catch(() => null);
    if (st?.isFile()) files.push({ path: full, mtimeMs: st.mtimeMs });
  }
  if (files.length === 0) return 0;

  // У выполненных задач payload затёрт, поэтому ссылки на аудио есть только
  // у ждущих, идущих и проваленных.
  const rows = await db
    .select({
      payload: jobsTable.payload,
      jobStatus: jobsTable.status,
      finishedAt: jobsTable.finishedAt,
      recordStatus: transcriptionsTable.status,
      recordUpdatedAt: transcriptionsTable.updatedAt,
    })
    .from(jobsTable)
    .leftJoin(transcriptionsTable, eq(transcriptionsTable.id, jobsTable.entityId))
    .where(
      and(
        eq(jobsTable.kind, "transcribe"),
        inArray(jobsTable.status, ["queued", "running", "error"]),
      ),
    );

  const refs: UploadRef[] = rows.map((r) => ({
    inputPath: (r.payload as { inputPath?: unknown }).inputPath,
    jobStatus: r.jobStatus,
    recordStatus: r.recordStatus,
    failedAtMs: (r.finishedAt ?? r.recordUpdatedAt)?.getTime() ?? null,
  }));

  let removed = 0;
  for (const p of pickUploadsToSweep(UPLOAD_DIR, files, refs, Date.now())) {
    await rm(p, { force: true })
      .then(() => {
        removed += 1;
      })
      .catch((err) => logger.warn({ err }, "Не смог удалить аудио из загрузок"));
  }
  if (removed > 0) logger.info({ removed }, "Убрал ненужное аудио из загрузок");
  return removed;
}
