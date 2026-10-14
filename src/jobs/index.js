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
import { activeTenantIds } from "../modules/catalog/service.js";
import { logger } from "../utils/logger.js";
import { orderSla, OFFLINE_PAYMENT_METHODS } from "../modules/orders/sla.js";

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

/**
 * Offline orders (COD / credit / PO) never time out on payment, so a seller who never confirms
 * would hold the buyer's stock and credit forever. Pending ones older than
 * `orders.confirmWithinHours` (default 48) are cancelled: stock released, ledger debit reversed,
 * cancelledBy "system", cancelCause "seller", cancelReason "seller_timeout"; buyer and seller are
 * notified (ORDER_AUTO_CANCELLED). The claim only matches while the order is still pending, so a
 * seller confirming at the same moment wins.
 */
async function orderSlaJob() {
  const sla = await orderSla();
  const cutoff = new Date(Date.now() - sla.confirmWithinHours * 60 * 60 * 1000);
  const orders = await Order.find({ status: "pending", paymentMethod: { $in: OFFLINE_PAYMENT_METHODS }, createdAt: { $lt: cutoff } })
    .sort({ createdAt: 1 })
    .limit(50);
  let cancelled = 0;
  for (const order of orders) {
    try {
      await cancelOrder(order, null, `Seller did not confirm within ${sla.confirmWithinHours} hours`, {
        from: ["pending"],
        cancelledBy: "system",
        cancelCause: "seller",
        reasonCode: "seller_timeout",
      });
      cancelled += 1;
    } catch (err) {
      if (err.code !== "INVALID_STATE") logger.error("order-sla cancel", { order: order.orderNumber, err: err.message });
    }
  }
  // Phase 6: ship deadline (auto-cancel, ship_timeout) and "due soon" reminders to sellers.
  const { shipSlaStep, deadlineWarningsStep } = await import("../modules/orders/slaJobs.js");
  const ship = await shipSlaStep();
  const warnings = await deadlineWarningsStep();
  return { cancelled, ...ship, ...warnings };
}

/** Phase 6: auto-approve undecided returns, return-decision reminders, overdue refund alerts. */
async function returnsSla() {
  const { runReturnsSla } = await import("../modules/orders/slaJobs.js");
  return runReturnsSla();
}

/** Phase 6: disputes nobody answered in time go to the platform review queue. */
async function disputesSla() {
  const { runDisputesSla } = await import("../modules/disputes/service.js");
  return runDisputesSla();
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
  // Only stores that can sell (inactive stores keep the flag; they are alerted once reactivated).
  const tenantIds = await activeTenantIds();
  const rows = await Inventory.find({
    isLow: true,
    lastLowStockAlertAt: null,
    archived: { $ne: true },
    tenantId: { $in: tenantIds },
  }).limit(200);
  let alerted = 0;
  for (const row of rows) {
    if (await alertIfLow(row)) alerted += 1;
  }
  return { alerted };
}

/**
 * Daily FSSAI compliance: expiry reminders (30 / 7 / 1 days, FSSAI_EXPIRING) and, once a licence
 * has expired, food products of that store hidden (enabled:false + complianceHold) until the
 * platform admin records the renewed licence (catalog/compliance.js).
 */
async function fssaiCompliance() {
  const { runFssaiCompliance } = await import("../modules/catalog/compliance.js");
  return runFssaiCompliance();
}

/** Seller subscriptions: renewal invoices, past_due + reminders, pause after grace, legacy expiry (billing/service.js). */
async function billingRenewals() {
  const { runBillingRenewals } = await import("../modules/billing/service.js");
  return runBillingRenewals();
}

/** Razorpay settlement reconciliation of yesterday (IST) (payouts/reconciliation.js, p4-tax). */
async function payoutReconcile() {
  const { reconcileYesterday } = await import("../modules/payouts/reconciliation.js");
  return reconcileYesterday();
}

async function retryEvents() {
  const events = await retryFailedEvents();
  const refunds = await processPendingRefunds({ limit: 50 });
  return { events: events ?? null, refunds };
}

/** Seller payouts (p4-payouts): ledger repair sweep, Route transfers, finality, scheduled payout run. */
async function payouts() {
  const { runPayoutsJob } = await import("../modules/payouts/service.js");
  return runPayoutsJob();
}

/** Poll Razorpay for Route linked accounts still under review (p4-payouts). */
async function linkedAccountsSync() {
  const { runLinkedAccountsSync } = await import("../modules/payouts/service.js");
  return runLinkedAccountsSync();
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
  "order-sla": orderSlaJob,
  "returns-sla": returnsSla,
  "disputes-sla": disputesSla,
  "fssai-compliance": fssaiCompliance,
  "billing-renewals": billingRenewals,
  "payout-reconcile": payoutReconcile,
  payouts,
  "linked-accounts-sync": linkedAccountsSync,
  cleanup,
};

const LEASE_MS = {
  "reservation-timeout": 5 * 60 * 1000,
  "scheduled-publish": 5 * 60 * 1000,
  "low-stock": 10 * 60 * 1000,
  "retry-events": 10 * 60 * 1000,
  "order-sla": 10 * 60 * 1000,
  "returns-sla": 10 * 60 * 1000,
  "disputes-sla": 10 * 60 * 1000,
  "fssai-compliance": 30 * 60 * 1000,
  "billing-renewals": 30 * 60 * 1000,
  "payout-reconcile": 30 * 60 * 1000,
  payouts: 30 * 60 * 1000,
  "linked-accounts-sync": 15 * 60 * 1000,
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
  "order-sla": "*/15 * * * *",
  "returns-sla": "*/15 * * * *",
  "disputes-sla": "*/15 * * * *",
  "fssai-compliance": "30 2 * * *",
  "billing-renewals": "7 * * * *",
  "payout-reconcile": "15 4 * * *",
  // 04:30 UTC = 10:00 IST (payouts/service.js nextPayoutAt assumes this time).
  payouts: "30 4 * * *",
  "linked-accounts-sync": "20 * * * *",
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
