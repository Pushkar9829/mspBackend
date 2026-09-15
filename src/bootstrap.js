import { env } from "./config/env.js";
import { connectDb } from "./config/db.js";
import { createApp } from "./app.js";
import { storage } from "./utils/storage.js";
import { seedFoundation, seedDemoCatalog } from "./seeds/index.js";
import { registerNotificationListeners } from "./modules/notifications/service.js";

export const app = createApp();

let prepared;

export function prepareRuntime({
  seed = env.seedOnStart,
  demo = env.seedDemo,
} = {}) {
  if (!prepared) {
    prepared = (async () => {
      await connectDb();
      try {
        await storage.ensure();
      } catch (err) {
        console.warn("Upload dir not available:", err.message);
      }
      registerNotificationListeners();
      if (seed) {
        await seedFoundation();
        if (demo) await seedDemoCatalog();
      }
      return app;
    })().catch((err) => {
      prepared = undefined;
      throw err;
    });
  }
  return prepared;
}
