import { eq } from "drizzle-orm";
import { db, transcriptionsTable } from "@workspace/db";
import { logger } from "./logger";

const INTERRUPTED_MESSAGE =
  "Распознавание прервалось. Попробуйте ещё раз.";

/**
 * Background transcription jobs run in memory in this server process. If the
 * server restarts mid-transcription, those jobs are gone but their rows are
 * left stuck in "processing" forever. Since no job can survive a restart, any
 * row still in "processing" at startup is orphaned — flip it to a retryable
 * error state with a friendly Russian message so the user isn't stuck waiting.
 */
export async function reconcileStaleTranscriptions(): Promise<void> {
  try {
    const rows = await db
      .update(transcriptionsTable)
      .set({
        status: "error",
        statusMessage: "",
        error: INTERRUPTED_MESSAGE,
      })
      .where(eq(transcriptionsTable.status, "processing"))
      .returning({ id: transcriptionsTable.id });

    if (rows.length > 0) {
      logger.warn(
        { count: rows.length, ids: rows.map((r) => r.id) },
        "Reconciled stale transcriptions left in 'processing' after restart",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to reconcile stale transcriptions on startup");
  }
}
