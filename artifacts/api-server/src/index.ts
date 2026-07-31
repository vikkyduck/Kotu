import app from "./app";
import { logger } from "./lib/logger";
import { purgeExpiredSessions } from "./lib/auth";
import { requeueOrphans, startWorker } from "./lib/jobs";
import { sweepTranscriptionsToLibrary, sweepOrphanDeckDirs } from "./lib/transcript-doc";
import { registerTranscribeHandler } from "./lib/handlers/transcribe";
import { registerIngestHandler } from "./lib/handlers/ingest";
import { registerLectureHandlers } from "./lib/handlers/lecture";
import { registerStoryboardHandler } from "./lib/handlers/storyboard";
import { registerIllustrateHandler } from "./lib/handlers/illustrate";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

void purgeExpiredSessions().catch((err) => logger.warn({ err }, "Не удалось почистить сессии"));

registerTranscribeHandler();
registerIngestHandler();
registerLectureHandlers();
registerStoryboardHandler();
registerIllustrateHandler();

// Задачи, оборванные прошлым перезапуском, возвращаем в очередь и продолжаем
// работу — ради этого очередь и заведена.
void requeueOrphans()
  .then((n) => {
    if (n > 0) logger.info({ count: n }, "Вернул в очередь прерванные задачи");
  })
  .catch((err) => logger.error({ err }, "Не смог вернуть задачи в очередь"))
  .finally(() => startWorker());

// Готовые расшифровки без библиотечной копии: бэкфилл старых и самолечение
// после сбоев. Идемпотентно, поэтому просто на каждом старте.
void sweepTranscriptionsToLibrary()
  .then((n) => {
    if (n > 0) logger.info({ count: n }, "Отправил расшифровки в библиотеку");
  })
  .catch((err) => logger.error({ err }, "Сверка расшифровок с библиотекой не удалась"));

void sweepOrphanDeckDirs().catch((err) =>
  logger.error({ err }, "Сверка каталогов презентаций не удалась"),
);

void Promise.resolve().finally(() => {
  const server = app.listen(port, () => {
    logger.info({ port }, "Server listening");
  });

  server.on("error", (err) => {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  });

  // Release the port promptly on restart. Without an explicit shutdown a
  // SIGTERM can leave the listening socket bound (or the process orphaned),
  // so the next start fails with EADDRINUSE and uploads stop working.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    server.close(() => process.exit(0));
    // Don't wait forever for in-flight requests (e.g. long uploads).
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
});
