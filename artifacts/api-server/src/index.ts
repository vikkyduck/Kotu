import app from "./app";
import { logger } from "./lib/logger";
import { purgeExpiredSessions } from "./lib/auth";
import { requeueOrphans, startWorker } from "./lib/jobs";
import { sweepTranscriptionsToLibrary } from "./lib/transcript-doc";
import { sweepWorkToLibrary, sweepStuckDeckImages } from "./lib/work-doc";
import { ensureArchive, startFileSweep } from "./lib/archive";
import { registerTranscribeHandler } from "./lib/handlers/transcribe";
import { registerIngestHandler } from "./lib/handlers/ingest";
import { registerLectureHandlers } from "./lib/handlers/lecture";
import { registerStoryboardHandler } from "./lib/handlers/storyboard";
import { registerIllustrateHandler } from "./lib/handlers/illustrate";
import { registerReslideHandler } from "./lib/handlers/reslide";

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
registerReslideHandler();

// Архив «всего» — первым делом: и очередь, и стартовые сверки меняют и
// удаляют строки и файлы, а без триггеров архива это шло бы мимо него.
// ensureArchive не бросает: не включился — громко в лог и archive:"off" в
// /api/healthz, сервер работает дальше, а удаления файлов он откажет сам.
const archiveReady = ensureArchive();

// Задачи, оборванные прошлым перезапуском, возвращаем в очередь и продолжаем
// работу — ради этого очередь и заведена.
void archiveReady
  .then(() => requeueOrphans())
  .then((n) => {
    if (n > 0) logger.info({ count: n }, "Вернул в очередь прерванные задачи");
  })
  .catch((err) => logger.error({ err }, "Не смог вернуть задачи в очередь"))
  .finally(() => startWorker());

// Готовые расшифровки без библиотечной копии: бэкфилл старых и самолечение
// после сбоев. Идемпотентно, поэтому просто на каждом старте.
void archiveReady
  .then(() => sweepTranscriptionsToLibrary())
  .then((n) => {
    if (n > 0) logger.info({ count: n }, "Отправил расшифровки в библиотеку");
  })
  .catch((err) => logger.error({ err }, "Сверка расшифровок с библиотекой не удалась"));

// Каталоги картинок удалённых презентаций больше не чистим: решение владелицы
// 23.09.2026 — система сама ничего не стирает. Сирота остаётся на диске и
// в любом случае лежит в архиве файлов.

void archiveReady
  .then(() => sweepStuckDeckImages())
  .catch((err) => logger.error({ err }, "Сверка брошенных образов не удалась"));

// Готовые лекции и презентации без копии в библиотеке: бэкфилл старых и
// самолечение после сбоев. Идемпотентно, поэтому просто на каждом старте.
void archiveReady
  .then(() => sweepWorkToLibrary())
  .then((n) => {
    if (n > 0) logger.info({ count: n }, "Отправил готовые работы в библиотеку");
  })
  .catch((err) => logger.error({ err }, "Сверка работ с библиотекой не удалась"));

// Все файлы данных — в архив: первичная загрузка того, что уже лежит на
// диске, и страховка на случай места в коде, которое пишет мимо архива.
void archiveReady.then(() => startFileSweep());

// Порт открываем, когда архив включён: иначе на самом первом старте правка,
// успевшая раньше триггеров, прошла бы мимо архива. Но не ждём дольше
// полуминуты — зависшая база не должна держать сервер закрытым; тогда
// /api/healthz честно отвечает archive:"pending".
void Promise.race([
  archiveReady,
  new Promise<void>((resolve) => setTimeout(resolve, 30_000).unref()),
]).finally(() => {
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
