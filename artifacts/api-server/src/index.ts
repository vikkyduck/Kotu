import app from "./app";
import { logger } from "./lib/logger";
import { reconcileStaleTranscriptions } from "./lib/reconcile";

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

// Heal any transcriptions left stuck in "processing" by a previous restart
// before we start accepting new uploads.
void reconcileStaleTranscriptions().finally(() => {
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
