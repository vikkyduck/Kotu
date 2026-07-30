import { sql, eq } from "drizzle-orm";
import { db, jobsTable, type Job, type JobKind } from "@workspace/db";
import { logger } from "./logger";

/** Сколько раз пробуем задачу, прежде чем признать её проваленной. */
const MAX_ATTEMPTS = 3;
/** Пауза перед повтором — растёт с каждой попыткой. */
const RETRY_DELAYS_SEC = [30, 120];
/** Как часто заглядывать в очередь, когда работы нет. */
const IDLE_POLL_MS = 2000;

export interface JobHandler {
  run: (job: Job) => Promise<void>;
  /** Вызывается, когда попытки исчерпаны: пометить сущность как сломанную. */
  onGiveUp: (job: Job, message: string) => Promise<void>;
}

const handlers = new Map<JobKind, JobHandler>();

export function registerHandler(kind: JobKind, handler: JobHandler): void {
  handlers.set(kind, handler);
}

export async function enqueue(
  kind: JobKind,
  entityId: number,
  payload: Record<string, unknown> = {},
): Promise<Job> {
  const [job] = await db.insert(jobsTable).values({ kind, entityId, payload }).returning();
  return job;
}

/**
 * Забирает одну задачу. SKIP LOCKED позволяет нескольким воркерам работать
 * параллельно, не мешая друг другу и не выдавая одну задачу дважды.
 */
async function claimNext(): Promise<Job | null> {
  // Сырой SQL нужен ради SKIP LOCKED, но он возвращает колонки как есть
  // (entity_id, last_error…). Поэтому берём только id, а сам объект читаем
  // через Drizzle — с правильными именами полей и типами.
  const { rows } = await db.execute<{ id: string | number }>(sql`
    UPDATE jobs SET
      status = 'running',
      locked_at = now(),
      attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_after <= now()
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id
  `);

  const claimed = rows[0];
  if (!claimed) return null;

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, Number(claimed.id)))
    .limit(1);
  return job ?? null;
}

/**
 * Задачи, которые числятся выполняющимися, но никто их не выполняет, —
 * это след прошлого перезапуска. Возвращаем их в очередь: ради этого
 * очередь и заводилась.
 */
export async function requeueOrphans(): Promise<number> {
  const { rowCount } = await db.execute(sql`
    UPDATE jobs SET status = 'queued', locked_at = NULL
    WHERE status = 'running'
  `);
  return rowCount ?? 0;
}

async function finish(job: Job, error?: string): Promise<void> {
  if (!error) {
    await db.execute(sql`
      UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL
      WHERE id = ${job.id}
    `);
    return;
  }

  const retriesLeft = MAX_ATTEMPTS - job.attempts;
  if (retriesLeft > 0) {
    const delay = RETRY_DELAYS_SEC[Math.min(job.attempts - 1, RETRY_DELAYS_SEC.length - 1)];
    logger.warn({ jobId: job.id, attempt: job.attempts, delay }, "Задача упала, повторю");
    await db.execute(sql`
      UPDATE jobs SET
        status = 'queued',
        locked_at = NULL,
        last_error = ${error},
        run_after = now() + ${`${delay} seconds`}::interval
      WHERE id = ${job.id}
    `);
    return;
  }

  logger.error({ jobId: job.id, attempts: job.attempts }, "Задача провалена окончательно");
  await db.execute(sql`
    UPDATE jobs SET status = 'error', finished_at = now(), last_error = ${error}
    WHERE id = ${job.id}
  `);
  await handlers.get(job.kind)?.onGiveUp(job, error);
}

let running = false;

/** Однопоточный цикл: расшифровка упирается в процессор, параллелить нечего. */
export function startWorker(): void {
  if (running) return;
  running = true;

  const tick = async (): Promise<void> => {
    try {
      const job = await claimNext();
      if (!job) {
        setTimeout(() => void tick(), IDLE_POLL_MS);
        return;
      }

      const handler = handlers.get(job.kind);
      if (!handler) {
        await finish(job, `Нет обработчика для задачи «${job.kind}»`);
      } else {
        try {
          logger.info({ jobId: job.id, kind: job.kind }, "Беру задачу");
          await handler.run(job);
          await finish(job);
        } catch (err) {
          await finish(job, err instanceof Error ? err.message : String(err));
        }
      }
      // Сразу пробуем следующую — очередь могла накопиться.
      setImmediate(() => void tick());
    } catch (err) {
      logger.error({ err }, "Сбой цикла очереди");
      setTimeout(() => void tick(), IDLE_POLL_MS);
    }
  };

  void tick();
}
