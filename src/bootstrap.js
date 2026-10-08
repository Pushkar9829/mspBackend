import mongoose from "mongoose";
import { env } from "./config/env.js";
import { connectDb } from "./config/db.js";
import { createApp } from "./app.js";
import { storage } from "./utils/storage.js";
import { logger } from "./utils/logger.js";
import { ensureSystemRoles, seedFoundation, seedDemoCatalog } from "./seeds/index.js";
import { registerNotificationListeners } from "./modules/notifications/service.js";
import { runAuthMigrations, runStorefrontMigrations, syncAllIndexes } from "./seeds/migrations.js";

export { runAuthMigrations, runStorefrontMigrations, syncAllIndexes };

export const app = createApp();

let prepared;

/**
 * Ledger data migration (migrateReservations.migrateLedgers: legacy buyer terms, credit-limit /
 * paise backfill, orphan entries, payment reference keys, drop the old unique {userId} ledger
 * index). Idempotent and cheap when there is nothing to do; a JobLock lease (same collection
 * the background jobs use) keeps concurrently starting instances from running it twice at once.
 */
const LEDGER_MIGRATION_LOCK = "migration:ledgers";
const LEDGER_MIGRATION_LEASE_MS = 10 * 60 * 1000;

/**
 * Carrier webhooks only match fulfillments whose carrier is Delhivery. Older Delhivery bookings were
 * saved with an empty carrier; fill it in from the order's delivery partner. Idempotent and cheap
 * (matches nothing once done).
 */
export async function backfillDelhiveryCarrier() {
  const { Order } = await import("./modules/orders/order.model.js");
  const res = await Order.updateMany(
    { "deliveryPartner.id": "delhivery", fulfillments: { $elemMatch: { trackingNumber: { $nin: [null, ""] }, carrier: { $in: [null, ""] } } } },
    { $set: { "fulfillments.$[f].carrier": "Delhivery" } },
    { arrayFilters: [{ "f.trackingNumber": { $nin: [null, ""] }, "f.carrier": { $in: [null, ""] } }], timestamps: false }
  );
  if (res.modifiedCount) logger.info("delhivery carrier backfilled", { orders: res.modifiedCount });
  return res.modifiedCount;
}

export async function runLedgerMigrations() {
  const [{ JobLock }, { migrateLedgers }] = await Promise.all([
    import("./jobs/index.js"),
    import("./modules/inventory/migrateReservations.js"),
  ]);
  const owner = `bootstrap:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  let lock = null;
  try {
    lock = await JobLock.findOneAndUpdate(
      { _id: LEDGER_MIGRATION_LOCK, lockedUntil: { $lt: now } },
      { $set: { owner, lockedUntil: new Date(now.getTime() + LEDGER_MIGRATION_LEASE_MS) } },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  if (lock?.owner !== owner) return { ran: false, reason: "locked" };
  try {
    const result = await migrateLedgers();
    const { droppedIndexes, ...counts } = result;
    if (droppedIndexes.length || Object.values(counts).some(Boolean)) logger.info("ledger migration applied", result);
    await JobLock.updateOne(
      { _id: LEDGER_MIGRATION_LOCK, owner },
      { $set: { lockedUntil: new Date(0), lastRunAt: new Date(), lastResult: result, lastError: "" } }
    );
    return { ran: true, result };
  } catch (err) {
    await JobLock.updateOne(
      { _id: LEDGER_MIGRATION_LOCK, owner },
      { $set: { lockedUntil: new Date(0), lastRunAt: new Date(), lastError: err.message } }
    ).catch(() => {});
    throw err;
  }
}

async function isReplicaSetConnection() {
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    return Boolean(hello.setName || hello.msg === "isdbgrid");
  } catch {
    return false;
  }
}

export function prepareRuntime({ seed = env.seedOnStart, demo = env.seedDemo } = {}) {
  if (!prepared) {
    prepared = (async () => {
      await connectDb();
      if (!(await isReplicaSetConnection())) {
        logger.warn(
          "MongoDB is not a replica set: multi-document transactions are unavailable. Use a replica set / Atlas in every environment."
        );
      }
      try {
        await storage.ensure();
      } catch (err) {
        logger.warn("Upload dir not available", { err: err.message });
      }
      registerNotificationListeners();
      // Permission catalog + system roles are code-defined: always sync them (idempotent).
      await ensureSystemRoles();
      if (seed) {
        await seedFoundation();
        if (demo && !env.isProd) await seedDemoCatalog();
      }
      if (process.env.RUN_MIGRATIONS !== "false") {
        await runAuthMigrations().catch((err) => logger.error("auth migrations failed", { err: err.message }));
        await runStorefrontMigrations().catch((err) => logger.error("storefront migrations failed", { err: err.message }));
        await runLedgerMigrations().catch((err) => logger.error("ledger migrations failed", { err: err.message }));
        await backfillDelhiveryCarrier().catch((err) => logger.error("carrier backfill failed", { err: err.message }));
      }
      if (env.syncIndexes) await syncAllIndexes();
      try {
        const catalog = await import("./modules/catalog/service.js");
        if (typeof catalog.ensureProductSlugs === "function") await catalog.ensureProductSlugs();
      } catch (err) {
        logger.error("ensureProductSlugs failed", { err: err.message });
      }
      return app;
    })().catch((err) => {
      prepared = undefined;
      throw err;
    });
  }
  return prepared;
}
