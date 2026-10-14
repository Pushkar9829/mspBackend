/**
 * Razorpay settlement reconciliation + courier COD remittances (p4-tax).
 *
 * runReconciliation(date): pulls Razorpay's settlement recon for that IST day and matches each
 * row to our records:
 *   payment  pay_..  -> orders (razorpayPaymentId), subscription invoices, credit repayments
 *   refund   rfnd_.. -> order refunds (refunds[].providerRefundId)
 *   transfer trf_..  -> seller ledger entries / payouts carrying that transfer id
 *   reversal rvrsl_..-> the reversed transfer (row.transfer_id / notes) is ours
 *   settlement setl_.. (listSettlements of the day) -> its amount = sum of its recon rows
 * Item status: matched | mismatched (amount differs) | unknown (Razorpay row we cannot place) |
 * missing (ours, captured / refunded `lagDays` (2, i.e. T+2) days before `date`, never seen in
 * any recon so far). A later run that finally sees a "missing" id resolves the old item.
 */
import { ReconciliationRun, CodRemittance } from "./reconciliation.model.js";
import { SellerLedgerEntry, Payout, CreditRepayment } from "./models.js";
import { Order } from "../orders/order.model.js";
import { SubscriptionInvoice } from "../billing/invoice.model.js";
import { fetchSettlementRecon, listSettlements, toPaise } from "../checkout/razorpayApi.js";
import { AppError } from "../../utils/AppError.js";
import { istMidnight } from "./taxReports.js";

export const SETTLEMENT_LAG_DAYS = 2;

/** "YYYY-MM-DD" -> { year, month, day, from, to } (IST day). */
export function dayRange(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!m) throw new AppError(400, "date must be YYYY-MM-DD", "VALIDATION_ERROR");
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const from = istMidnight(year, month, day);
  if (Number.isNaN(from.getTime())) throw new AppError(400, "Invalid date", "VALIDATION_ERROR");
  return { year, month, day, from, to: new Date(from.getTime() + 86_400_000), label: m[0] };
}

/** IST calendar day "YYYY-MM-DD" of `date` shifted by `offsetDays`. */
export function istDay(date = new Date(), offsetDays = 0) {
  const d = new Date(new Date(date).getTime() + 330 * 60 * 1000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);

function rowType(row) {
  const t = String(row?.type || row?.entity_type || "").toLowerCase();
  if (["payment", "refund", "transfer", "reversal"].includes(t)) return t;
  const id = String(row?.entity_id || "");
  if (id.startsWith("pay_")) return "payment";
  if (id.startsWith("rfnd_")) return "refund";
  if (id.startsWith("trf_")) return "transfer";
  if (id.startsWith("rvrsl_")) return "reversal";
  return t || "other";
}

async function matchPayment(id) {
  const orders = await Order.find({ razorpayPaymentId: id }, { orderNumber: 1, tenantId: 1, total: 1, razorpayAmountPaise: 1 }).lean();
  if (orders.length) {
    const group = Math.max(...orders.map((o) => num(o.razorpayAmountPaise)));
    const expected = group > 0 ? group : orders.reduce((s, o) => s + toPaise(o.total), 0);
    return {
      ourKind: "order",
      ourRef: orders.map((o) => o.orderNumber).join(", "),
      orderIds: orders.map((o) => o._id),
      tenantId: orders.length === 1 ? orders[0].tenantId : null,
      expectedPaise: expected,
    };
  }
  const inv = await SubscriptionInvoice.findOne({ "payment.razorpayPaymentId": id }, { number: 1, tenantId: 1, total: 1 }).lean();
  if (inv) return { ourKind: "subscription_invoice", ourRef: inv.number || String(inv._id), tenantId: inv.tenantId, expectedPaise: toPaise(inv.total) };
  const rep = await CreditRepayment.findOne({ razorpayPaymentId: id }).lean();
  if (rep) return { ourKind: "credit_repayment", ourRef: String(rep._id), tenantId: rep.tenantId, expectedPaise: num(rep.paidPaise || rep.amountPaise) };
  return null;
}

async function matchRefund(id) {
  const order = await Order.findOne({ "refunds.providerRefundId": id }, { orderNumber: 1, tenantId: 1, refunds: 1 }).lean();
  if (!order) return null;
  const refund = (order.refunds || []).find((r) => r.providerRefundId === id);
  return { ourKind: "order_refund", ourRef: `${order.orderNumber} ${refund?.key || ""}`.trim(), orderIds: [order._id], tenantId: order.tenantId, expectedPaise: toPaise(refund?.amount || 0) };
}

async function matchTransfer(id) {
  const payout = await Payout.findOne({ "transfers.transferId": id }, { number: 1, tenantId: 1, transfers: 1 }).lean();
  const t = payout?.transfers?.find((x) => x.transferId === id);
  if (t && t.type === "direct") {
    return { ourKind: "payout", ourRef: payout.number, tenantId: payout.tenantId, orderIds: t.orderId ? [t.orderId] : [], expectedPaise: num(t.releasedPaise) };
  }
  const entries = await SellerLedgerEntry.find({ transferId: id, kind: { $nin: ["payout"] } }, { amountPaise: 1, tenantId: 1, orderId: 1, orderNumber: 1 }).lean();
  if (entries.length) {
    const expected = entries.reduce((s, e) => s + num(e.amountPaise), 0);
    const orderIds = [...new Set(entries.filter((e) => e.orderId).map((e) => String(e.orderId)))];
    return {
      ourKind: "order_transfer",
      ourRef: [...new Set(entries.map((e) => e.orderNumber).filter(Boolean))].join(", ") || (payout?.number ?? ""),
      tenantId: entries[0].tenantId,
      orderIds,
      expectedPaise: expected,
    };
  }
  if (t) return { ourKind: "payout", ourRef: payout.number, tenantId: payout.tenantId, expectedPaise: null };
  const order = await Order.findOne({ "payout.transferId": id }, { orderNumber: 1, tenantId: 1 }).lean();
  if (order) return { ourKind: "order_transfer", ourRef: order.orderNumber, tenantId: order.tenantId, orderIds: [order._id], expectedPaise: null };
  return null;
}

async function matchReversal(row) {
  const transferId = row.transfer_id || row.source || row.notes?.transfer_id || "";
  if (!transferId) return null;
  const m = await matchTransfer(String(transferId));
  return m ? { ...m, ourKind: "transfer_reversal", expectedPaise: null } : null;
}

function itemFrom(type, entityId, match, actual, row = {}) {
  const expected = match?.expectedPaise;
  let status = "matched";
  let problem = null;
  if (!match) {
    status = "unknown";
    problem = type === "settlement" ? "unrecognised_type" : "not_found";
  } else if (expected != null && actual != null && expected !== actual) {
    status = "mismatched";
    problem = type === "settlement" ? "settlement_total_mismatch" : "amount_mismatch";
  }
  return {
    type,
    status,
    entityId,
    ourRef: match?.ourRef || "",
    ourKind: match?.ourKind || "",
    orderIds: match?.orderIds || [],
    tenantId: match?.tenantId || null,
    expectedPaise: expected ?? null,
    actualPaise: actual,
    feePaise: num(row.fee),
    taxPaise: num(row.tax),
    settlementId: String(row.settlement_id || ""),
    problem,
  };
}

/** Our payments / refunds that should have settled on `date` (T + lag) but no recon ever showed. */
async function missingItems(date, seen, lagDays) {
  const { from, to } = dayRange(istDay(dayRange(date).from, -lagDays)); // IST day `lagDays` earlier
  const out = [];
  const orders = await Order.find(
    { razorpayPaymentId: { $gt: "" }, paidAt: { $gte: from, $lt: to } },
    { orderNumber: 1, tenantId: 1, total: 1, razorpayPaymentId: 1, razorpayAmountPaise: 1 }
  ).lean();
  const byPayment = new Map();
  for (const o of orders) {
    const list = byPayment.get(o.razorpayPaymentId) || [];
    list.push(o);
    byPayment.set(o.razorpayPaymentId, list);
  }
  for (const [id, list] of byPayment) {
    if (seen.has(id)) continue;
    const group = Math.max(...list.map((o) => num(o.razorpayAmountPaise)));
    out.push({
      type: "payment",
      status: "missing",
      entityId: id,
      ourRef: list.map((o) => o.orderNumber).join(", "),
      ourKind: "order",
      orderIds: list.map((o) => o._id),
      tenantId: list.length === 1 ? list[0].tenantId : null,
      expectedPaise: group > 0 ? group : list.reduce((s, o) => s + toPaise(o.total), 0),
      actualPaise: null,
      problem: "not_in_settlement",
    });
  }
  const refunded = await Order.find(
    { refunds: { $elemMatch: { status: "processed", providerRefundId: { $gt: "" }, processedAt: { $gte: from, $lt: to } } } },
    { orderNumber: 1, tenantId: 1, refunds: 1 }
  ).lean();
  for (const o of refunded) {
    for (const r of o.refunds || []) {
      if (r.status !== "processed" || !r.providerRefundId || !(r.processedAt >= from && r.processedAt < to)) continue;
      if (seen.has(r.providerRefundId)) continue;
      out.push({
        type: "refund",
        status: "missing",
        entityId: r.providerRefundId,
        ourRef: `${o.orderNumber} ${r.key}`,
        ourKind: "order_refund",
        orderIds: [o._id],
        tenantId: o.tenantId,
        expectedPaise: toPaise(r.amount),
        actualPaise: null,
        problem: "not_in_settlement",
      });
    }
  }
  return out;
}

function countItems(items) {
  const counts = { matched: 0, mismatched: 0, missing: 0, unknown: 0, unresolved: 0 };
  for (const i of items) {
    counts[i.status] += 1;
    if (i.status !== "matched" && !i.resolved?.at) counts.unresolved += 1;
  }
  return counts;
}

/**
 * Reconcile one IST settlement day. Re-running a day rebuilds its items but keeps manual
 * resolutions of the same (type, entityId). Returns the run document.
 */
export async function runReconciliation(date, { source = "admin", actorId = null, lagDays = SETTLEMENT_LAG_DAYS } = {}) {
  const day = dayRange(date);
  const previous = await ReconciliationRun.findOne({ date: day.label }).lean();
  const run = await ReconciliationRun.findOneAndUpdate(
    { date: day.label },
    { $set: { status: "running", source, startedAt: new Date(), error: "", createdBy: actorId || previous?.createdBy || null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  try {
    const rows = await fetchSettlementRecon({ year: day.year, month: day.month, day: day.day });
    let settlements = [];
    try {
      settlements = await listSettlements({ from: Math.floor(day.from.getTime() / 1000), to: Math.floor(day.to.getTime() / 1000) - 1 });
    } catch {
      settlements = []; // the settlement totals check is best effort
    }
    const items = [];
    const totals = { settledPaise: 0, feesPaise: 0, taxPaise: 0, rows: rows.length };
    const bySettlement = new Map();
    for (const row of rows) {
      const type = rowType(row);
      const id = String(row.entity_id || row.id || "");
      const credit = num(row.credit);
      const debit = num(row.debit);
      const net = credit || debit ? credit - debit : 0;
      totals.feesPaise += num(row.fee);
      totals.taxPaise += num(row.tax);
      if (row.settlement_id) bySettlement.set(row.settlement_id, (bySettlement.get(row.settlement_id) || 0) + net);
      const actual = num(row.amount);
      let match = null;
      if (type === "payment") match = await matchPayment(id);
      else if (type === "refund") match = await matchRefund(id);
      else if (type === "transfer") match = await matchTransfer(id);
      else if (type === "reversal") match = await matchReversal(row);
      if (!["payment", "refund", "transfer", "reversal"].includes(type)) {
        items.push(itemFrom("settlement", id || `${type}:${items.length}`, null, actual, row));
        continue;
      }
      items.push(itemFrom(type, id, match, actual, row));
    }
    for (const s of settlements) {
      const sum = bySettlement.get(s.id);
      totals.settledPaise += num(s.amount);
      if (sum == null) continue; // settlement of another day's rows
      items.push(itemFrom("settlement", s.id, { ourKind: "settlement", ourRef: s.utr || "", expectedPaise: sum }, num(s.amount), { fee: s.fees, tax: s.tax }));
    }
    // Ids already seen in any earlier run, plus this one.
    const ids = new Set(items.map((i) => i.entityId));
    const earlier = await ReconciliationRun.aggregate([
      { $match: { date: { $ne: day.label } } },
      { $unwind: "$items" },
      { $match: { "items.status": { $in: ["matched", "mismatched"] } } },
      { $group: { _id: "$items.entityId" } },
    ]);
    const seen = new Set([...ids, ...earlier.map((e) => e._id)]);
    items.push(...(await missingItems(day.label, seen, lagDays)));
    // Keep manual resolutions across re-runs.
    const resolvedBefore = new Map((previous?.items || []).filter((i) => i.resolved?.at).map((i) => [`${i.type}:${i.entityId}`, i.resolved]));
    for (const i of items) {
      const r = resolvedBefore.get(`${i.type}:${i.entityId}`);
      if (r) i.resolved = r;
    }
    const counts = countItems(items);
    const done = await ReconciliationRun.findByIdAndUpdate(
      run._id,
      { $set: { status: "completed", items, counts, totals, finishedAt: new Date() } },
      { new: true }
    );
    // Earlier "missing" items that this day's recon finally contains are resolved automatically.
    const found = items.filter((i) => i.status === "matched" || i.status === "mismatched").map((i) => i.entityId);
    if (found.length) {
      const stale = await ReconciliationRun.find({ date: { $ne: day.label }, items: { $elemMatch: { status: "missing", entityId: { $in: found }, "resolved.at": null } } });
      for (const old of stale) {
        for (const it of old.items) {
          if (it.status === "missing" && found.includes(it.entityId) && !it.resolved?.at) {
            it.resolved = { by: null, at: new Date(), note: `Seen in settlement recon of ${day.label}` };
          }
        }
        old.counts = countItems(old.items);
        await old.save();
      }
    }
    return done;
  } catch (err) {
    await ReconciliationRun.updateOne({ _id: run._id }, { $set: { status: "failed", error: String(err?.message || err).slice(0, 500), finishedAt: new Date() } });
    throw err;
  }
}

/** Job `payout-reconcile`: yesterday (IST). Skips quietly while Razorpay is not configured. */
export async function reconcileYesterday({ now = new Date() } = {}) {
  const date = istDay(now, -1);
  try {
    const run = await runReconciliation(date, { source: "job" });
    return { date, counts: run.counts };
  } catch (err) {
    if (err?.code === "PAYMENT_UNAVAILABLE") return { date, skipped: "razorpay_not_configured" };
    throw err;
  }
}

function presentRun(run, { withItems = false, status, problemOnly = false } = {}) {
  const r = typeof run.toObject === "function" ? run.toObject() : run;
  const out = { ...r, id: r._id };
  if (!withItems) delete out.items;
  else {
    let items = r.items || [];
    if (status) items = items.filter((i) => String(status).split(",").includes(i.status));
    if (problemOnly) items = items.filter((i) => i.status !== "matched");
    out.items = items.map((i) => ({ ...i, id: i._id }));
  }
  return out;
}

export async function listRuns({ page = 1, limit = 30 } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 30));
  const [rows, total] = await Promise.all([
    ReconciliationRun.find({}, { items: 0 }).sort({ date: -1 }).skip((p - 1) * l).limit(l).lean(),
    ReconciliationRun.countDocuments({}),
  ]);
  return { data: rows.map((r) => presentRun(r)), meta: { page: p, limit: l, total, pages: Math.ceil(total / l) } };
}

export async function getRun(id, query = {}) {
  const run = await ReconciliationRun.findById(id).lean();
  if (!run) throw new AppError(404, "Reconciliation run not found", "NOT_FOUND");
  return presentRun(run, { withItems: true, status: query.status, problemOnly: query.problems === "true" || query.problems === true });
}

export async function resolveItem(runId, itemId, { note }, actorId) {
  const run = await ReconciliationRun.findById(runId);
  if (!run) throw new AppError(404, "Reconciliation run not found", "NOT_FOUND");
  const item = run.items.id(itemId);
  if (!item) throw new AppError(404, "Item not found", "NOT_FOUND");
  if (item.status === "matched") throw new AppError(409, "Matched items need no resolution", "INVALID_STATE");
  item.resolved = { by: actorId || null, at: new Date(), note: String(note || "").slice(0, 1000) };
  run.counts = countItems(run.items);
  await run.save();
  return presentRun(run, { withItems: true });
}

/* ------------------------------------------------------------------ COD remittances */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Record a courier COD remittance: each row (orderNumber or AWB + amount in INR) is matched to a
 * delivered courier-COD order; the order gets codCollection.remittedAt / remittanceReference;
 * rows paying less / more than the collected amount are flagged short / excess.
 */
export async function recordCodRemittance({ carrier, reference, receivedAt, rows = [], note = "" }, actorId = null) {
  const at = receivedAt ? new Date(receivedAt) : new Date();
  const dup = await CodRemittance.findOne({ carrier, reference }).lean();
  if (dup) throw new AppError(409, "This remittance reference was already recorded for the carrier", "DUPLICATE");
  const out = [];
  const used = new Set();
  for (const raw of rows) {
    const amount = round2(raw.amount);
    const filter = raw.orderNumber ? { orderNumber: String(raw.orderNumber).trim() } : { "fulfillments.trackingNumber": String(raw.awb || "").trim() };
    const order = raw.orderNumber || raw.awb ? await Order.findOne(filter) : null;
    const row = { orderNumber: raw.orderNumber || order?.orderNumber || "", awb: raw.awb || "", orderId: order?._id || null, tenantId: order?.tenantId || null, amount, expected: 0, difference: 0, status: "ok" };
    if (!order) row.status = "not_found";
    else if (order.paymentMethod !== "cod" || order.codCollection?.by !== "courier") row.status = "not_courier_cod";
    else if (order.codCollection?.remittedAt || used.has(String(order._id))) {
      row.status = "already_remitted";
      row.expected = round2(order.codCollection.amount || order.total);
    } else {
      row.expected = round2(order.codCollection.amount || order.total);
      row.difference = round2(amount - row.expected);
      row.status = row.difference < 0 ? "short" : row.difference > 0 ? "excess" : "ok";
      const res = await Order.updateOne(
        { _id: order._id, "codCollection.remittedAt": null },
        { $set: { "codCollection.remittedAt": at, "codCollection.remittanceReference": String(reference).slice(0, 120) } }
      );
      if (!res.modifiedCount) row.status = "already_remitted";
      used.add(String(order._id));
    }
    out.push(row);
  }
  const totals = {
    expected: round2(out.reduce((s, r) => s + (["ok", "short", "excess"].includes(r.status) ? r.expected : 0), 0)),
    received: round2(out.reduce((s, r) => s + r.amount, 0)),
    short: round2(out.filter((r) => r.status === "short").reduce((s, r) => s - r.difference, 0)),
    excess: round2(out.filter((r) => r.status === "excess").reduce((s, r) => s + r.difference, 0)),
    matchedOrders: out.filter((r) => ["ok", "short", "excess"].includes(r.status)).length,
    flagged: out.filter((r) => r.status !== "ok").length,
  };
  const doc = await CodRemittance.create({ carrier, reference, receivedAt: at, rows: out, totals, note, createdBy: actorId });
  return { ...doc.toObject(), id: doc._id };
}

export async function listCodRemittances({ page = 1, limit = 30, carrier } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 30));
  const filter = carrier ? { carrier } : {};
  const [rows, total] = await Promise.all([
    CodRemittance.find(filter).sort({ receivedAt: -1 }).skip((p - 1) * l).limit(l).lean(),
    CodRemittance.countDocuments(filter),
  ]);
  return { data: rows.map((r) => ({ ...r, id: r._id })), meta: { page: p, limit: l, total, pages: Math.ceil(total / l) } };
}

/** Delivered courier-COD orders whose cash the carrier has not remitted yet, oldest first, with age in days. */
export async function unremittedCod({ carrier, olderThanDays = 0, page = 1, limit = 50, now = new Date() } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(200, Math.max(1, Number(limit) || 50));
  const filter = { paymentMethod: "cod", "codCollection.by": "courier", "codCollection.remittedAt": null, status: { $nin: ["cancelled"] } };
  if (carrier) filter["codCollection.carrier"] = new RegExp(`^${String(carrier).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
  if (Number(olderThanDays) > 0) filter["codCollection.at"] = { $lt: new Date(now.getTime() - Number(olderThanDays) * 86_400_000) };
  const [rows, total, sum] = await Promise.all([
    Order.find(filter, { orderNumber: 1, tenantId: 1, total: 1, codCollection: 1, deliveredAt: 1, fulfillments: 1, status: 1 })
      .sort({ "codCollection.at": 1 })
      .skip((p - 1) * l)
      .limit(l)
      .populate("tenantId", "name slug")
      .lean(),
    Order.countDocuments(filter),
    Order.aggregate([{ $match: filter }, { $group: { _id: null, amount: { $sum: { $ifNull: ["$codCollection.amount", "$total"] } } } }]),
  ]);
  return {
    data: rows.map((o) => {
      const at = o.codCollection?.at || o.deliveredAt;
      const fwd = (o.fulfillments || []).find((f) => f.kind !== "return" && f.trackingNumber);
      return {
        orderId: o._id,
        orderNumber: o.orderNumber,
        store: o.tenantId ? { id: o.tenantId._id, name: o.tenantId.name, slug: o.tenantId.slug } : null,
        carrier: o.codCollection?.carrier || fwd?.carrier || "",
        awb: fwd?.trackingNumber || "",
        amount: round2(o.codCollection?.amount || o.total),
        collectedAt: at,
        ageDays: at ? Math.floor((now.getTime() - new Date(at).getTime()) / 86_400_000) : null,
        status: o.status,
      };
    }),
    meta: { page: p, limit: l, total, amount: round2(sum[0]?.amount || 0) },
  };
}
