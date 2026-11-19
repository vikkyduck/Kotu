import { sql, eq, and, desc, inArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db, jobsTable, type Job, type JobKind } from "@workspace/db";
import { logger } from "./logger";
import { ModelWaitError } from "./codex";

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
  /**
   * Задача отложена до сброса лимита подписки (или до повторного входа):
   * показать причину и время продолжения на карточке. Попытка не тратится.
   */
  onWait?: (job: Job, message: string) => Promise<void>;
}

const handlers = new Map<JobKind, JobHandler>();

/** Кому сообщать об итоге задачи (уведомления владелице). Задает index.ts. */
export interface JobEvents {
  done?: (job: Job) => void;
  failed?: (job: Job, message: string) => void;
}
let events: JobEvents = {};

export function onJobEvents(listener: JobEvents): void {
  events = listener;
}

export function registerHandler(kind: JobKind, handler: JobHandler): void {
  handlers.set(kind, handler);
}

/** Подпись сущности, пока её задача ждёт в очереди, — одна на все разделы. */
export const QUEUED_MESSAGE = "В очереди…";

/**
 * Ставит задачу. С tx — в той же транзакции, что и смена статуса сущности:
 * иначе сбой между ними оставит её «в работе» без задачи навсегда.
 */
export async function enqueue(
  kind: JobKind,
  entityId: number,
  payload: object = {},
  tx: Pick<typeof db, "insert"> = db,
): Promise<Job> {
  const [job] = await tx
    .insert(jobsTable)
    .values({ kind, entityId, payload: payload as Record<string, unknown> })
    .returning();
  return job;
}

/** Ответ повтора, когда ошибки уже нет (повторили в другой вкладке, двойной клик). */
export const NOTHING_TO_RETRY = "Повторять нечего — ошибки нет";

/** Работа со строкой статуса: лекции, презентации, документы, записи. */
type WorkTable = PgTable & { id: PgColumn; status: PgColumn; statusMessage: PgColumn; error: PgColumn };

/** onWait задачи: причина ожидания и время продолжения - строкой статуса на карточке работы. */
export function showWaitOn(table: WorkTable): NonNullable<JobHandler["onWait"]> {
  return async (job, message) => {
    await db
      .update(table as PgTable)
      .set({ statusMessage: message } as Record<string, unknown>)
      .where(eq(table.id, job.entityId));
  };
}

/** Работа - в ошибку с фразой для человека. Возвращает, сколько строк нашлось: 0 - работы уже нет. */
export async function markFailed(table: WorkTable, id: number, error: string): Promise<number> {
  const rows = await db
    .update(table as PgTable)
    .set({ status: "error", statusMessage: "", error } as Record<string, unknown>)
    .where(eq(table.id, id))
    .returning({ id: table.id });
  return rows.length;
}

/** onGiveUp простой работы: в ошибку с понятной фразой; сбой записи - в журнал, не наружу. */
export function failOn(
  table: WorkTable,
  what: string,
  shown: (message: string) => string = (m) => m,
): JobHandler["onGiveUp"] {
  return async (job, message) => {
    await markFailed(table, job.entityId, shown(message)).catch((err) =>
      logger.error({ err, id: job.entityId }, `Не смог записать ошибку: ${what}`),
    );
  };
}

/** Транзакция Drizzle - то, что получает колбэк db.transaction. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Таблица работ со статусом: лекции, презентации, документы, записи. */
type StatusTable = PgTable & { id: PgColumn; status: PgColumn; error: PgColumn };

/**
 * Смена статуса работы и её задача - одной транзакцией, с условием на прежний
 * статус в самом UPDATE. Работа «в работе» без задачи невозможна, а второй
 * клик или вторая вкладка уже не найдут прежний статус и второй задачи не
 * поставят. Возвращает обновлённую строку или null - статус уже другой.
 * before - то, что должно случиться в той же транзакции до задачи (главы
 * лекции, сброс образов колоды).
 */
export async function transitionAndEnqueue<T extends StatusTable>(opts: {
  table: T;
  id: number;
  from: readonly string[];
  set: Partial<T["$inferInsert"]>;
  kind: JobKind;
  payload?: object;
  before?: (tx: Tx, row: T["$inferSelect"]) => Promise<unknown>;
}): Promise<T["$inferSelect"] | null> {
  const { table, id, from, set, kind, payload = {}, before } = opts;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(table as PgTable)
      .set({ error: null, ...set } as Record<string, unknown>)
      .where(and(eq(table.id, id), inArray(table.status, [...from])))
      .returning();
    if (!row) return null;
    const updated = row as T["$inferSelect"];
    if (before) await before(tx, updated);
    await enqueue(kind, id, payload, tx);
    return updated;
  });
}

/**
 * Последняя задача сущности. Payload у задач не затирается (см. finish) —
 * из него повтор берёт то, с чем работать: путь к файлу, вставленный текст.
 */
export async function lastJob(kind: JobKind, entityId: number): Promise<Job | null> {
  const [job] = await db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.kind, kind), eq(jobsTable.entityId, entityId)))
    .orderBy(desc(jobsTable.id))
    .limit(1);
  return job ?? null;
}

/**
 * Задача по этой вещи ещё в очереди или в работе. Вещь бывает «в ошибке» при
 * живой задаче (сбой между концом задачи и onGiveUp) - тогда повтор ставил бы
 * вторую задачу на ту же работу. Одна проверка на все повторы.
 */
export async function hasActiveJob(kinds: readonly JobKind[], entityId: number): Promise<boolean> {
  const [job] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        inArray(jobsTable.kind, [...kinds]),
        eq(jobsTable.entityId, entityId),
        inArray(jobsTable.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  return job !== undefined;
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

/**
 * Модель недоступна по причине, которая проходит сама: лимит подписки,
 * отозванный вход, пауза агента. Задача возвращается в очередь до указанного
 * времени, а попытка возвращается: иначе три таких отказа подряд сожгли бы
 * задачу, которая через час прошла бы без единой ошибки.
 */
async function postpone(job: Job, wait: ModelWaitError): Promise<void> {
  logger.warn({ jobId: job.id, kind: job.kind, reason: wait.kind, until: wait.until }, "Задача ждет модели");
  await db.execute(sql`
    UPDATE jobs SET
      status = 'queued',
      locked_at = NULL,
      attempts = GREATEST(attempts - 1, 0),
      last_error = ${wait.message},
      run_after = ${wait.until.toISOString()}::timestamptz
    WHERE id = ${job.id}
  `);
  await handlers
    .get(job.kind)
    ?.onWait?.(job, wait.message)
    .catch((err) => logger.error({ err, jobId: job.id }, "Не смог показать ожидание на карточке"));
}

/** Итог одной попытки. Экспортирован для тестов очереди. */
export async function finish(job: Job, failure?: unknown): Promise<void> {
  if (failure instanceof ModelWaitError) {
    await postpone(job, failure);
    return;
  }
  const error = failure === undefined ? undefined : failure instanceof Error ? failure.message : String(failure);
  if (!error) {
    // Payload НЕ затираем (решение владелицы 23.09.2026: система сама ничего
    // не стирает). В нём путь к аудио записи — по нему удаление записи
    // уносит аудио в архив — и вставленный текст презентации.
    await db.execute(sql`
      UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL
      WHERE id = ${job.id}
    `);
    events.done?.(job);
    return;
  }

  const retriesLeft = MAX_ATTEMPTS - job.attempts;
  if (retriesLeft > 0) {
    const delay = RETRY_DELAYS_SEC[Math.min(job.attempts - 1, RETRY_DELAYS_SEC.length - 1)];
    // Причина — в журнал: у задачи, которая с третьего раза прошла,
    // last_error затирается, и без этой строки узнать, что было, нельзя.
    logger.warn(
      { jobId: job.id, kind: job.kind, attempt: job.attempts, delay, error },
      "Задача упала, повторю",
    );
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

  logger.error(
    { jobId: job.id, kind: job.kind, attempts: job.attempts, error },
    "Задача провалена окончательно",
  );
  await db.execute(sql`
    UPDATE jobs SET status = 'error', finished_at = now(), last_error = ${error}
    WHERE id = ${job.id}
  `);
  await handlers.get(job.kind)?.onGiveUp(job, error);
  events.failed?.(job, error);
}

let running = false;

/**
 * Однопоточный цикл: расшифровка упирается в процессор, параллелить нечего.
 * canRun — можно ли брать новую задачу. Сейчас это «архив включён»: если он
 * выключится на ходу (пропал триггер, база не отвечает), новые задачи ждут,
 * чтобы машина не писала поверх текстов мимо архива.
 */
export function startWorker(canRun: () => boolean = () => true): void {
  if (running) return;
  running = true;
  let paused = false;

  const tick = async (): Promise<void> => {
    if (!canRun()) {
      if (!paused) {
        paused = true;
        logger.warn("Очередь стоит: архив не включён — задачи ждут");
      }
      setTimeout(() => void tick(), IDLE_POLL_MS);
      return;
    }
    if (paused) {
      paused = false;
      logger.info("Архив снова включён — очередь продолжает работу");
    }
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
          await finish(job, err);
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
