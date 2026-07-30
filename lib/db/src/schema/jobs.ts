import { pgTable, bigserial, integer, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export type JobKind = "transcribe";
export type JobStatus = "queued" | "running" | "done" | "error";

/**
 * Очередь фоновой работы.
 *
 * Раньше задачи жили в памяти процесса: перезапуск сервера (в том числе обычный
 * деплой) убивал расшифровку, и запись зависала навсегда. Теперь состояние
 * лежит в базе — задача переживает рестарт и подхватывается заново.
 *
 * Отдельный брокер (Redis и т.п.) не нужен: пользователь один, а Postgres
 * умеет выдавать задачи конкурентно через FOR UPDATE SKIP LOCKED.
 */
export const jobsTable = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").$type<JobKind>().notNull(),
    /** Ссылка на предметную сущность — сейчас всегда transcriptions.id. */
    entityId: integer("entity_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Не брать задачу раньше этого времени — пауза между повторами. */
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    pending: index("jobs_pending_idx").on(t.status, t.runAfter),
  }),
);

export type Job = typeof jobsTable.$inferSelect;
