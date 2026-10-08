import http from "http";
import mongoose from "mongoose";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { app, prepareRuntime } from "./bootstrap.js";
import { attachSockets } from "./sockets/index.js";
import { getIo } from "./utils/io.js";

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { err: reason instanceof Error ? reason : String(reason) });
});
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException — shutting down", { err });
  // State may be corrupt after an uncaught exception: exit after a best-effort graceful stop.
  shutdown("uncaughtException", 1);
});

let server;
let jobsModule;
let shuttingDown = false;

async function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  const force = setTimeout(() => process.exit(code || 1), 10000);
  force.unref();
  try {
    if (typeof jobsModule?.stopJobs === "function") await jobsModule.stopJobs();
  } catch (err) {
    logger.error("stopJobs failed", { err: err.message });
  }
  try {
    const io = getIo();
    if (io) await new Promise((resolve) => io.close(() => resolve()));
  } catch (err) {
    logger.error("socket close failed", { err: err.message });
  }
  try {
    if (server?.listening) await new Promise((resolve) => server.close(() => resolve()));
  } catch (err) {
    logger.error("http close failed", { err: err.message });
  }
  try {
    await mongoose.disconnect();
  } catch (err) {
    logger.error("mongo disconnect failed", { err: err.message });
  }
  process.exit(code);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main() {
  await prepareRuntime();

  server = http.createServer(app);
  attachSockets(server);

  jobsModule = await import("./jobs/index.js");
  if (env.disableInProcessJobs) {
    logger.info("in-process cron disabled (DISABLE_IN_PROCESS_JOBS); drive jobs via /api/internal/cron/:name");
  } else if (typeof jobsModule.startJobs === "function") {
    jobsModule.startJobs();
  }

  server.listen(env.port, env.host, () => {
    logger.info(`mspNode listening on http://${env.host}:${env.port}`, { env: env.nodeEnv });
  });
}

main().catch((err) => {
  logger.error("Failed to start mspNode", { err });
  process.exit(1);
});
