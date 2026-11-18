import { eq } from "drizzle-orm";
import { db, decksTable, lecturesTable, transcriptionsTable, type Job } from "@workspace/db";
import { notifyOwner } from "./notify";
import { logger } from "./logger";

/**
 * Сообщения владелице в Telegram о готовых и проваленных задачах платформы.
 * Идут через мост ПСИ (lib/notify.ts), как и уведомления о запасном ключе.
 * Выключаются строкой NOTIFY_DONE=off в .env.
 */

const base = (): string => (process.env["PUBLIC_BASE_URL"] ?? "https://psy3107.ru").replace(/\/+$/, "");
const enabled = (): boolean => (process.env["NOTIFY_DONE"] ?? "on") !== "off";

async function lecture(id: number) {
  const [row] = await db.select().from(lecturesTable).where(eq(lecturesTable.id, id)).limit(1);
  return row ?? null;
}

async function deck(id: number) {
  const [row] = await db.select().from(decksTable).where(eq(decksTable.id, id)).limit(1);
  return row ?? null;
}

async function transcription(id: number) {
  const [row] = await db.select().from(transcriptionsTable).where(eq(transcriptionsTable.id, id)).limit(1);
  return row ?? null;
}

/** Текст о готовой задаче или null, если сообщать не о чем. */
export async function doneText(job: Job): Promise<string | null> {
  const id = job.entityId;
  switch (job.kind) {
    case "lecture.plan": {
      const row = await lecture(id);
      return row?.status === "plan_ready"
        ? `План лекции "${row.title}" готов, его нужно утвердить: ${base()}/#/lecture/${id}`
        : null;
    }
    case "lecture.write": {
      const row = await lecture(id);
      return row?.status === "ready" ? `Лекция "${row.title}" готова: ${base()}/#/lecture/${id}` : null;
    }
    case "deck.storyboard": {
      const row = await deck(id);
      return row?.status === "storyboard_ready"
        ? `Раскадровка презентации "${row.title}" готова, ее нужно утвердить: ${base()}/#/deck/${id}`
        : null;
    }
    case "deck.illustrate": {
      // Большая колода рисуется цепочкой задач: сообщаем, только когда готова вся.
      const row = await deck(id);
      return row?.status === "ready" ? `Презентация "${row.title}" готова: ${base()}/#/deck/${id}` : null;
    }
    case "transcribe": {
      const row = await transcription(id);
      return row?.status === "done" ? `Расшифровка "${row.title}" готова: ${base()}/#/record/${id}` : null;
    }
    default:
      return null;
  }
}

/** Текст о проваленной задаче или null для задач, о которых не сообщаем. */
export async function failedText(job: Job, message: string): Promise<string | null> {
  const id = job.entityId;
  if (job.kind === "lecture.plan" || job.kind === "lecture.write") {
    const row = await lecture(id);
    return `Лекция "${row?.title ?? id}" не получилась: ${message}. ${base()}/#/lecture/${id}`;
  }
  if (job.kind === "deck.storyboard" || job.kind === "deck.illustrate") {
    const row = await deck(id);
    return `Презентация "${row?.title ?? id}" не получилась: ${message}. ${base()}/#/deck/${id}`;
  }
  if (job.kind === "transcribe") {
    const row = await transcription(id);
    return `Расшифровка "${row?.title ?? id}" не получилась: ${message}. ${base()}/#/record/${id}`;
  }
  return null;
}

export async function noticeDone(job: Job): Promise<void> {
  if (!enabled()) return;
  const text = await doneText(job);
  if (text) await notifyOwner(text);
}

export async function noticeFailed(job: Job, message: string): Promise<void> {
  if (!enabled()) return;
  const text = await failedText(job, message);
  if (text) await notifyOwner(text);
}

/** Сбой уведомления не должен влиять на очередь. */
export function safely(run: () => Promise<void>): void {
  void run().catch((err) => logger.warn({ err }, "Уведомление о задаче не отправлено"));
}
