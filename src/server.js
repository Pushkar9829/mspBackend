import http from "http";
import { env } from "./config/env.js";
import { connectDb } from "./config/db.js";
import { createApp } from "./app.js";
import { attachSockets } from "./sockets/index.js";
import { startJobs } from "./jobs/index.js";
import { seedFoundation, seedDemoCatalog } from "./seeds/index.js";
import { registerNotificationListeners } from "./modules/notifications/service.js";
import { storage } from "./utils/storage.js";

async function main() {
  await connectDb();
  await storage.ensure();
  await seedFoundation();
  await seedDemoCatalog();
  registerNotificationListeners();

  const app = createApp();
  const server = http.createServer(app);
  attachSockets(server);
  startJobs();

  server.listen(env.port, () => {
    console.log(`mspNode listening on http://localhost:${env.port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start mspNode:", err.message);
  process.exit(1);
});
