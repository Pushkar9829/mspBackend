import mongoose from "mongoose";
import { Order } from "../orders/order.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { Dispute, SELLER_LOST_STATUSES, OPEN_DISPUTE_STATUSES } from "../disputes/dispute.model.js";
import { orderSla, OFFLINE_PAYMENT_METHODS, SLA_CANCEL_REASONS, effectiveSetting } from "../orders/sla.js";
import { AppError } from "../../utils/AppError.js";

/**
 * Phase 6 seller scorecard over a rolling window (30 or 90 days, orders by createdAt):
 *  - cancelRate      seller-caused cancels (seller cancels + deadline auto-cancels; NOT buyer /
 *                    payment-timeout / admin) / orders
 *  - lateShipRate    (shipped after confirm + orders.shipWithinHours, + ship_timeout cancels) /
 *                    (shipped + ship_timeout cancels)
 *  - returnRate      units returned / units delivered (+ seller-fault returned units)
 *  - disputeRate     disputes opened / delivered orders (+ disputes lost: refund / reopen)
 *  - avgConfirmHours offline orders (COD / credit / PO) created -> confirmed
 *  - avgShipHours    confirmed -> first shipped / out for delivery / delivered
 * Thresholds (settings scorecard.max*Rate, percent): value > max -> "bad", > 75% of max ->
 * "warning", else "good". Informational only (no automatic penalties).
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
export const SCORECARD_WINDOWS = [30, 90];
const MIN_SAMPLE = 5;

export async function thresholds() {
  const [cancel, late, ret, dispute] = await Promise.all([
    effectiveSetting(null, "scorecard.maxCancelRate"),
    effectiveSetting(null, "scorecard.maxLateShipRate"),
    effectiveSetting(null, "scorecard.maxReturnRate"),
    effectiveSetting(null, "scorecard.maxDisputeRate"),
  ]);
  const pct = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return { cancelRate: pct(cancel, 5), lateShipRate: pct(late, 10), returnRate: pct(ret, 15), disputeRate: pct(dispute, 3) };
}

function rate(count, base, maxPercent) {
  const value = base > 0 ? count / base : 0;
  const percent = Math.round(value * 10000) / 100;
  let status = "good";
  if (base > 0 && percent > maxPercent) status = "bad";
  else if (base > 0 && maxPercent > 0 && percent > maxPercent * 0.75) status = "warning";
  return { value: Math.round(value * 10000) / 10000, percent, count, base, threshold: maxPercent, status, lowSample: base < MIN_SAMPLE };
}

const worst = (list) => (list.includes("bad") ? "bad" : list.includes("warning") ? "warning" : "good");

/** Per-store raw counters for orders created since `from` (aggregation; `tenantIds` optional). */
async function orderStats(from, tenantIds = null, shipWithinHours = 72) {
  const match = { createdAt: { $gte: from } };
  if (tenantIds) match.tenantId = { $in: tenantIds };
  const firstAt = (statuses) => ({
    $min: {
      $map: {
        input: { $filter: { input: { $ifNull: ["$statusHistory", []] }, as: "h", cond: { $in: ["$$h.status", statuses] } } },
        as: "h",
        in: "$$h.at",
      },
    },
  });
  const rows = await Order.aggregate([
    { $match: match },
    {
      $project: {
        tenantId: 1,
        status: 1,
        cancelCause: 1,
        cancelReason: 1,
        paymentMethod: 1,
        createdAt: 1,
        deliveredAt: 1,
        confirmedAt: firstAt(["confirmed"]),
        shippedAt: firstAt(["shipped", "out_for_delivery", "delivered"]),
        itemsQty: { $sum: "$items.qty" },
        returnedQty: { $sum: { $map: { input: "$items", as: "i", in: { $ifNull: ["$$i.returnedQty", 0] } } } },
        returns: { $ifNull: ["$returns", []] },
      },
    },
    {
      $project: {
        tenantId: 1,
        cancelled: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
        sellerCancel: { $cond: [{ $and: [{ $eq: ["$status", "cancelled"] }, { $eq: ["$cancelCause", "seller"] }] }, 1, 0] },
        slaCancel: { $cond: [{ $and: [{ $eq: ["$status", "cancelled"] }, { $in: ["$cancelReason", SLA_CANCEL_REASONS] }] }, 1, 0] },
        shipTimeout: { $cond: [{ $and: [{ $eq: ["$status", "cancelled"] }, { $eq: ["$cancelReason", "ship_timeout"] }] }, 1, 0] },
        buyerCancel: { $cond: [{ $and: [{ $eq: ["$status", "cancelled"] }, { $eq: ["$cancelCause", "buyer"] }] }, 1, 0] },
        shipped: { $cond: [{ $and: [{ $ne: ["$shippedAt", null] }, { $ne: ["$confirmedAt", null] }] }, 1, 0] },
        late: {
          $cond: [
            {
              $and: [
                { $ne: ["$shippedAt", null] },
                { $ne: ["$confirmedAt", null] },
                { $gt: [{ $subtract: ["$shippedAt", "$confirmedAt"] }, shipWithinHours * HOUR] },
              ],
            },
            1,
            0,
          ],
        },
        shipMs: {
          $cond: [{ $and: [{ $ne: ["$shippedAt", null] }, { $ne: ["$confirmedAt", null] }] }, { $subtract: ["$shippedAt", "$confirmedAt"] }, null],
        },
        confirmMs: {
          $cond: [
            { $and: [{ $ne: ["$confirmedAt", null] }, { $in: ["$paymentMethod", OFFLINE_PAYMENT_METHODS] }] },
            { $subtract: ["$confirmedAt", "$createdAt"] },
            null,
          ],
        },
        delivered: { $cond: [{ $ne: ["$deliveredAt", null] }, 1, 0] },
        deliveredQty: { $cond: [{ $ne: ["$deliveredAt", null] }, "$itemsQty", 0] },
        returnedQty: 1,
        sellerFaultQty: {
          $sum: {
            $map: {
              input: { $filter: { input: "$returns", as: "r", cond: { $and: [{ $eq: ["$$r.status", "received"] }, { $eq: ["$$r.sellerFault", true] }] } } },
              as: "r",
              in: { $sum: "$$r.items.qty" },
            },
          },
        },
        returnRequests: { $size: "$returns" },
        autoApproved: { $size: { $filter: { input: "$returns", as: "r", cond: { $eq: ["$$r.autoApproved", true] } } } },
        returnsRejected: { $size: { $filter: { input: "$returns", as: "r", cond: { $eq: ["$$r.status", "rejected"] } } } },
        qcRejected: { $size: { $filter: { input: "$returns", as: "r", cond: { $gt: [{ $size: { $ifNull: ["$$r.qc.items", []] } }, 0] } } } },
        pickupFailed: { $size: { $filter: { input: "$returns", as: "r", cond: { $eq: ["$$r.status", "pickup_failed"] } } } },
      },
    },
    {
      $group: {
        _id: "$tenantId",
        orders: { $sum: 1 },
        cancelled: { $sum: "$cancelled" },
        sellerCancels: { $sum: "$sellerCancel" },
        slaCancels: { $sum: "$slaCancel" },
        shipTimeouts: { $sum: "$shipTimeout" },
        buyerCancels: { $sum: "$buyerCancel" },
        shipped: { $sum: "$shipped" },
        late: { $sum: "$late" },
        avgShipMs: { $avg: "$shipMs" },
        avgConfirmMs: { $avg: "$confirmMs" },
        delivered: { $sum: "$delivered" },
        deliveredQty: { $sum: "$deliveredQty" },
        returnedQty: { $sum: "$returnedQty" },
        sellerFaultQty: { $sum: "$sellerFaultQty" },
        returnRequests: { $sum: "$returnRequests" },
        autoApproved: { $sum: "$autoApproved" },
        returnsRejected: { $sum: "$returnsRejected" },
        qcRejected: { $sum: "$qcRejected" },
        pickupFailed: { $sum: "$pickupFailed" },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

async function disputeStats(from, tenantIds = null) {
  const match = { openedAt: { $gte: from } };
  if (tenantIds) match.tenantId = { $in: tenantIds };
  const rows = await Dispute.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$tenantId",
        opened: { $sum: 1 },
        lost: { $sum: { $cond: [{ $in: ["$status", SELLER_LOST_STATUSES] }, 1, 0] } },
        won: { $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] } },
        open: { $sum: { $cond: [{ $in: ["$status", OPEN_DISPUTE_STATUSES] }, 1, 0] } },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

const hours = (ms) => (ms == null ? null : Math.round((ms / HOUR) * 10) / 10);

function build(tenant, o = {}, d = {}, { days, from, to, limits }) {
  const shipBase = (o.shipped || 0) + (o.shipTimeouts || 0);
  const metrics = {
    cancelRate: rate((o.sellerCancels || 0), o.orders || 0, limits.cancelRate),
    lateShipRate: rate((o.late || 0) + (o.shipTimeouts || 0), shipBase, limits.lateShipRate),
    returnRate: rate(o.returnedQty || 0, o.deliveredQty || 0, limits.returnRate),
    disputeRate: rate(d.opened || 0, o.delivered || 0, limits.disputeRate),
  };
  metrics.returnRate.sellerFaultCount = o.sellerFaultQty || 0;
  metrics.returnRate.sellerFaultPercent = o.deliveredQty ? Math.round(((o.sellerFaultQty || 0) / o.deliveredQty) * 10000) / 100 : 0;
  metrics.disputeRate.lost = d.lost || 0;
  return {
    tenantId: tenant._id,
    store: { id: tenant._id, name: tenant.name, slug: tenant.slug, status: tenant.status },
    days,
    from,
    to,
    orders: o.orders || 0,
    delivered: o.delivered || 0,
    unitsDelivered: o.deliveredQty || 0,
    unitsReturned: o.returnedQty || 0,
    cancellations: { total: o.cancelled || 0, sellerCaused: o.sellerCancels || 0, slaAutoCancels: o.slaCancels || 0, shipTimeouts: o.shipTimeouts || 0, buyer: o.buyerCancels || 0 },
    shipments: { shipped: o.shipped || 0, late: o.late || 0 },
    avgConfirmHours: hours(o.avgConfirmMs),
    avgShipHours: hours(o.avgShipMs),
    returns: {
      requests: o.returnRequests || 0,
      autoApproved: o.autoApproved || 0,
      rejected: o.returnsRejected || 0,
      qcRejected: o.qcRejected || 0,
      pickupFailed: o.pickupFailed || 0,
    },
    disputes: { opened: d.opened || 0, lost: d.lost || 0, won: d.won || 0, open: d.open || 0 },
    metrics,
    overall: worst(Object.values(metrics).map((m) => m.status)),
  };
}

function windowOf(days) {
  const n = Number(days) || 30;
  if (!SCORECARD_WINDOWS.includes(n)) throw new AppError(400, "days must be 30 or 90", "VALIDATION_ERROR");
  const to = new Date();
  return { days: n, from: new Date(to.getTime() - n * DAY), to };
}

/** One store's scorecard. */
export async function storeScorecard(tenantId, { days = 30 } = {}) {
  if (!mongoose.isValidObjectId(String(tenantId))) throw new AppError(404, "Store not found", "NOT_FOUND");
  const tenant = await Tenant.findById(tenantId, "name slug status").lean();
  if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
  const w = windowOf(days);
  const [limits, sla] = await Promise.all([thresholds(), orderSla()]);
  const ids = [tenant._id];
  const [o, d] = await Promise.all([orderStats(w.from, ids, sla.shipWithinHours), disputeStats(w.from, ids)]);
  return build(tenant, o.get(String(tenant._id)), d.get(String(tenant._id)), { ...w, limits });
}

const SORT_KEYS = {
  cancelRate: (r) => r.metrics.cancelRate.value,
  lateShipRate: (r) => r.metrics.lateShipRate.value,
  returnRate: (r) => r.metrics.returnRate.value,
  disputeRate: (r) => r.metrics.disputeRate.value,
  disputesLost: (r) => r.disputes.lost,
  orders: (r) => r.orders,
  name: (r) => String(r.store.name || "").toLowerCase(),
  overall: (r) => ({ good: 0, warning: 1, bad: 2 })[r.overall],
};

/**
 * Every store with orders (or disputes) in the window: { days, from, to, thresholds, data, meta,
 * counts: { good, warning, bad } }. sort = cancelRate | lateShipRate | returnRate | disputeRate |
 * disputesLost | orders | name | overall (default overall), order = asc | desc (default desc;
 * name asc), status = good|warning|bad filter, q = store name.
 */
export async function allScorecards(query = {}) {
  const w = windowOf(query.days);
  const [limits, sla] = await Promise.all([thresholds(), orderSla()]);
  const [o, d] = await Promise.all([orderStats(w.from, null, sla.shipWithinHours), disputeStats(w.from, null)]);
  const ids = [...new Set([...o.keys(), ...d.keys()])].filter((id) => mongoose.isValidObjectId(id));
  const tenantFilter = { _id: { $in: ids } };
  if (query.q) tenantFilter.name = new RegExp(String(query.q).trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const tenants = await Tenant.find(tenantFilter, "name slug status").lean();
  let rows = tenants.map((t) => build(t, o.get(String(t._id)), d.get(String(t._id)), { ...w, limits }));
  const counts = { good: 0, warning: 0, bad: 0 };
  for (const r of rows) counts[r.overall] += 1;
  if (query.status) rows = rows.filter((r) => r.overall === query.status);
  const sortKey = SORT_KEYS[query.sort] ? query.sort : "overall";
  const dir = (query.order || (sortKey === "name" ? "asc" : "desc")) === "asc" ? 1 : -1;
  const key = SORT_KEYS[sortKey];
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x < y) return -dir;
    if (x > y) return dir;
    return b.orders - a.orders;
  });
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const total = rows.length;
  return {
    days: w.days,
    from: w.from,
    to: w.to,
    thresholds: limits,
    data: rows.slice((page - 1) * limit, page * limit),
    meta: { total, page, limit, pages: Math.ceil(total / limit) || 0 },
    counts,
  };
}
