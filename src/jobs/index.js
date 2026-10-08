import os from "os";
import mongoose from "mongoose";
import cron from "node-cron";
import { Inventory } from "../modules/inventory/inventory.model.js";
import { Order } from "../modules/orders/order.model.js";
import { Cart } from "../modules/cart/cart.model.js";
import { retryFailedEvents } from "../utils/events.js";
import { publishScheduled as publishCms } from "../modules/cms/service.js";
import { publishScheduled as publishNotes } from "../modules/notifications/service.js";
import { cancelOrder } from "../modules/orders/lifecycle.js";
import { releaseExpiredHolds, alertIfLow } from "../modules/inventory/service.js";
import { processPendingRefunds } from "../modules/checkout/refunds.js";
import { ONLINE_PAYMENT_METHODS } from "../modules/checkout/razorpayApi.js";
import { CART_RESERVATION_MINUTES } from "../config/constants.js";
import { logger } from "../utils/logger.js";

/**
 * Background jobs. Every job is safe to run concurrently and on several instances:
 *  - a Mongo lease lock (`JobLock`) lets only one runner execute a job at a time, and
 *  - every unit of work inside a job is itself an atomic conditional claim, so even two
 *    runners that overlap (expired lease) cannot double-release stock or double-cancel.
 * Run on a schedule with startJobs() (long-lived server) or one-shot via runJob(name)
 * (serverless cron: POST /api/internal/cron/:name).
 */

const jobLockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    owner: { type: String, default: "" },
    lockedUntil: { type: Date, default: new Date(0) },
    lastRunAt: { type: Date, default: null },
    lastResult: { type: mongoose.Schema.Types.Mixed, default: null },
    lastError: { type: String, default: "" },
  },
  { versionKey: false }
);
export const JobLock = mongoose.models.JobLock || mongoose.model("JobLock", jobLockSchema);

const OWNER = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;

async function acquire(name, leaseMs) {
  const now = new Date();
  try {
    const doc = await JobLock.findOneAndUpdate(
      { _id: name, lockedUntil: { $lt: now } },
      { $set: { owner: OWNER, lockedUntil: new Date(now.getTime() + leaseMs) } },
      { upsert: true, new: true }
    );
    return doc?.owner === OWNER;
  } catch (err) {
    if (err?.code === 11000) return false; // someone else holds it
    throw err;
  }
}

async function release(name, result, error) {
  await JobLock.updateOne(
    { _id: name, owner: OWNER },
    { $set: { lockedUntil: new Date(0), lastRunAt: new Date(), lastResult: result ?? null, lastError: error || "" } }
  ).catch(() => {});
}

/* ------------------------------------------------------------------- jobs */

/** Release expired cart holds, then cancel unpaid online orders past the payment window. */
async function reservationTimeout() {
  const releasedHolds = await releaseExpiredHolds({ now: new Date(), limit: 500 });
  const cutoff = new Date(Date.now() - CART_RESERVATION_MINUTES * 60 * 1000);
  const orders = await Order.find({
    status: "pending",
    paymentMethod: { $in: ONLINE_PAYMENT_METHODS },
    paymentStatus: { $nin: ["paid", "refunded"] },
    createdAt: { $lt: cutoff },
  })
    .sort({ createdAt: 1 })
    .limit(50);
  let cancelled = 0;
  for (const order of orders) {
    try {
      // requireUnpaid: the claim only matches while the order is still unpaid, so a payment
      // landing at the same moment wins and the order is not cancelled.
      await cancelOrder(order, null, "Payment not received in time", { timeout: true, requireUnpaid: true, from: ["pending"] });
      cancelled += 1;
    } catch (err) {
      if (err.code !== "INVALID_STATE") logger.error("reservation-timeout cancel", { order: order.orderNumber, err: err.message });
    }
  }
  return { releasedHolds, cancelled };
}

async function scheduledPublish() {
  await publishCms();
  await publishNotes();
  // Re-checks products.publish and emits PRODUCT_PUBLISHED per product (catalog module).
  const { publishScheduledProducts } = await import("../modules/catalog/service.js");
  const products = await publishScheduledProducts();
  return { products };
}

/** One LOW_STOCK / OUT_OF_STOCK per low episode per row (atomic claim on lastLowStockAlertAt). */
async function lowStock() {
  const rows = await Inventory.find({ isLow: true, lastLowStockAlertAt: null, archived: { $ne: true } }).limit(200);
  let alerted = 0;
  for (const row of rows) {
    if (await alertIfLow(row)) alerted += 1;
  }
  return { alerted };
}

async function retryEvents() {
  const events = await retryFailedEvents();
  const refunds = await processPendingRefunds({ limit: 50 });
  return { events: events ?? null, refunds };
}

async function cleanup() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  // Guest carts carry a TTL index (expiresAt); this sweeps legacy guest carts without one.
  const res = await Cart.deleteMany({
    userId: null,
    updatedAt: { $lt: cutoff },
    $or: [{ "items.0": { $exists: false } }, { expiresAt: null }],
    "items.reservationId": { $not: { $type: "objectId" } },
  });
  return { guestCarts: res.deletedCount || 0 };
}

export const JOBS = {
  "reservation-timeout": reservationTimeout,
  "scheduled-publish": scheduledPublish,
  "low-stock": lowStock,
  "retry-events": retryEvents,
  cleanup,
};

const LEASE_MS = {
  "reservation-timeout": 5 * 60 * 1000,
  "scheduled-publish": 5 * 60 * 1000,
  "low-stock": 10 * 60 * 1000,
  "retry-events": 10 * 60 * 1000,
  cleanup: 30 * 60 * 1000,
};

/** Run one job now (cron endpoint / tests). Returns { ran: false } when another runner holds it. */
export async function runJob(name) {
  const fn = JOBS[name];
  if (!fn) {
    const err = new Error(`Unknown job ${name}`);
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  if (!(await acquire(name, LEASE_MS[name] || 5 * 60 * 1000))) return { job: name, ran: false, reason: "locked" };
  try {
    const result = await fn();
    await release(name, result);
    return { job: name, ran: true, result };
  } catch (err) {
    await release(name, null, err.message);
    throw err;
  }
}

const SCHEDULES = {
  "reservation-timeout": "* * * * *",
  "scheduled-publish": "* * * * *",
  "low-stock": "*/15 * * * *",
  "retry-events": "*/5 * * * *",
  cleanup: "0 3 * * *",
};

let tasks = [];

export function startJobs() {
  if (tasks.length) return tasks;
  tasks = Object.entries(SCHEDULES).map(([name, expr]) =>
    cron.schedule(
      expr,
      async () => {
        try {
          await runJob(name);
        } catch (err) {
          logger.error(`job ${name} failed`, { err: err.message });
        }
      },
      { name, noOverlap: true }
    )
  );
  return tasks;
}

export async function stopJobs() {
  const running = tasks;
  tasks = [];
  for (const task of running) {
    try {
      await task.stop();
    } catch {
      /* ignore */
    }
  }
}
