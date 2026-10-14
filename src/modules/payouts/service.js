import mongoose from "mongoose";
import { Tenant } from "../tenants/tenant.model.js";
import { Order } from "../orders/order.model.js";
import { SellerLedgerEntry, Payout, PayoutCounter, SELLER_LEDGER_KINDS } from "./models.js";
import { payoutSettings } from "./settings.js";
import { writeEntries, balanceFor, releaseFinalOrders, recordMissing, toPaise } from "./ledger.js";
import {
  linkedAccountActive,
  ensureOrderTransfer,
  reverseOrderTransfer,
  releaseOrderTransfer,
  transferRemaining,
  createOrRefreshLinkedAccount,
  syncLinkedAccount,
  bankAccountNumber,
} from "./route.js";
import * as rzp from "../checkout/razorpayApi.js";
import { withTransaction, afterCommit } from "../../utils/transaction.js";
import { emitDomain } from "../../utils/events.js";
import { AppError } from "../../utils/AppError.js";
import { logger } from "../../utils/logger.js";
import { loadUserRefs, userRef } from "../../utils/userRefs.js";

/* ------------------------------------------------------------------ helpers */

const oid = (v) => new mongoose.Types.ObjectId(String(v?._id || v));
const DAY = 24 * 60 * 60 * 1000;
/** Payout job time: 04:30 UTC (10:00 IST). Keep in sync with jobs/index.js + vercel.json. */
const RUN_HOUR_UTC = 4;
const RUN_MINUTE_UTC = 30;

/** Financial year code of a date in IST: 2026-10-11 -> "2627". */
export function fyCode(date = new Date()) {
  const ist = new Date(date.getTime() + 330 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${String(start).slice(2)}${String(start + 1).slice(2)}`;
}

async function nextPayoutNumber(session) {
  const fy = fyCode();
  const row = await PayoutCounter.findOneAndUpdate({ _id: `PO:${fy}` }, { $inc: { seq: 1 } }, { upsert: true, new: true, session });
  return `PO/${fy}/${String(row.seq).padStart(6, "0")}`;
}

/** Next scheduled payout run after `now` (daily, or Mondays when weekly). */
export function nextPayoutAt(schedule = "daily", now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RUN_HOUR_UTC, RUN_MINUTE_UTC));
  if (d <= now) d.setTime(d.getTime() + DAY);
  if (schedule === "weekly") while (d.getUTCDay() !== 1) d.setTime(d.getTime() + DAY);
  return d;
}

export function presentEntry(e) {
  if (!e) return null;
  return {
    id: e._id,
    tenantId: e.tenantId,
    key: e.key,
    kind: e.kind,
    amountPaise: e.amountPaise,
    orderId: e.orderId || null,
    orderNumber: e.orderNumber || "",
    refundRef: e.refundRef || "",
    payoutId: e.payoutId || null,
    transferId: e.transferId || "",
    subscriptionInvoiceId: e.subscriptionInvoiceId || null,
    held: !e.availableAt,
    availableAt: e.availableAt || null,
    heldReason: e.heldReason || "",
    memo: e.memo || "",
    data: e.data || {},
    createdAt: e.createdAt,
  };
}

export function presentPayout(p, { admin = false } = {}) {
  if (!p) return null;
  const plain = typeof p.toObject === "function" ? p.toObject() : { ...p };
  const out = {
    id: plain._id,
    tenantId: plain.tenantId?._id || plain.tenantId,
    number: plain.number,
    amountPaise: plain.amountPaise,
    mode: plain.mode,
    status: plain.status,
    gross: plain.gross || {},
    deductions: plain.deductions || {},
    transfers: (plain.transfers || []).map((t) => ({
      type: t.type,
      transferId: t.transferId,
      orderId: t.orderId,
      releasedPaise: t.releasedPaise,
      reversedPaise: t.reversedPaise,
      status: t.status,
      ...(admin ? { error: t.error || "" } : {}),
    })),
    entryCount: (plain.entryIds || []).length,
    reference: plain.reference || "",
    paidAt: plain.paidAt || null,
    failureReason: plain.failureReason || "",
    cancelReason: plain.cancelReason || "",
    recreditedAt: plain.recreditedAt || null,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
  if (plain.tenantId?.name) out.tenant = { id: plain.tenantId._id, name: plain.tenantId.name, slug: plain.tenantId.slug };
  if (admin) {
    out.entryIds = plain.entryIds || [];
    out.createdBy = plain.createdBy || null;
    out.history = plain.history || [];
  }
  return out;
}

function accountView(tenant) {
  const p = tenant?.payout || {};
  return {
    status: p.status || "not_created",
    razorpayAccountId: p.razorpayAccountId || "",
    requirements: p.requirements || [],
    lastError: p.lastError || "",
    activatedAt: p.activatedAt || null,
    syncedAt: p.syncedAt || null,
  };
}

function bankView(tenant) {
  const b = tenant?.kyc?.bank || {};
  return { holderName: b.holderName || "", last4: b.accountLast4 || "", ifsc: b.ifsc || "", verified: Boolean(b.verified) };
}

function holdView(tenant) {
  const h = tenant?.payout?.onHold;
  return h ? { reason: h.reason || "", at: h.at || null, by: h.by || null } : null;
}

async function pendingPayoutPaise(tenantId) {
  const [row] = await Payout.aggregate([
    { $match: { tenantId: oid(tenantId), status: { $in: ["pending_manual", "processing", "failed"] }, recreditedAt: null } },
    { $group: { _id: null, total: { $sum: "$amountPaise" } } },
  ]);
  return row?.total || 0;
}

async function subscriptionDuePaise(tenantId) {
  try {
    const { outstandingAmount } = await import("../billing/service.js");
    return toPaise(await outstandingAmount(tenantId));
  } catch {
    return 0;
  }
}

/** Seller overview (GET /payouts/me and admin seller detail). */
export async function sellerOverview(tenantId) {
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
  const settings = await payoutSettings();
  const [bal, pending, subDue, last] = await Promise.all([
    balanceFor(tenantId),
    pendingPayoutPaise(tenantId),
    subscriptionDuePaise(tenantId),
    Payout.findOne({ tenantId, status: "paid" }).sort({ paidAt: -1 }).lean(),
  ]);
  return {
    balance: {
      availablePaise: Math.max(0, bal.availablePaise),
      heldPaise: bal.heldPaise,
      owedPaise: Math.max(0, -bal.availablePaise),
      netAvailablePaise: bal.availablePaise,
      pendingPayoutPaise: pending,
      subscriptionDuePaise: subDue,
    },
    nextPayoutAt: tenant.payout?.onHold ? null : nextPayoutAt(settings.schedule),
    lastPayout: last ? presentPayout(last) : null,
    mode: settings.mode,
    schedule: settings.schedule,
    minAmountPaise: settings.minAmountPaise,
    holdDaysAfterDelivery: settings.holdDaysAfterDelivery,
    account: accountView(tenant),
    bank: bankView(tenant),
    hold: holdView(tenant),
  };
}

function dateBound(value, end = false) {
  if (!value) return null;
  const s = String(value);
  // Date-only values are IST calendar days, like the rest of the app.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000+05:30` : s);
  if (Number.isNaN(d.getTime())) throw new AppError(400, `Invalid date ${s}`, "VALIDATION_ERROR");
  if (end && /^\d{4}-\d{2}-\d{2}$/.test(s)) d.setTime(d.getTime() + DAY - 1);
  return d;
}

function paging(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

/** Paged ledger lines (newest first). Filters: kind (comma list), orderId, payoutId, from, to, status held|available. */
export async function listLedger(tenantId, query = {}) {
  const filter = { tenantId: oid(tenantId) };
  if (query.kind) {
    const kinds = String(query.kind).split(",").map((k) => k.trim()).filter(Boolean);
    const bad = kinds.find((k) => !SELLER_LEDGER_KINDS.includes(k));
    if (bad) throw new AppError(400, `Unknown kind ${bad}`, "VALIDATION_ERROR");
    filter.kind = { $in: kinds };
  }
  if (query.orderId) filter.orderId = oid(query.orderId);
  if (query.payoutId) filter.payoutId = oid(query.payoutId);
  if (query.status === "held") filter.availableAt = null;
  if (query.status === "available") filter.availableAt = { $ne: null };
  const from = dateBound(query.from);
  const to = dateBound(query.to, true);
  if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const { page, limit, skip } = paging(query);
  const [rows, total] = await Promise.all([
    SellerLedgerEntry.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    SellerLedgerEntry.countDocuments(filter),
  ]);
  return { data: rows.map(presentEntry), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

export async function listPayouts(filter = {}, query = {}, { admin = false } = {}) {
  const f = { ...filter };
  if (query.status) f.status = { $in: String(query.status).split(",").map((s) => s.trim()).filter(Boolean) };
  if (query.tenantId) f.tenantId = oid(query.tenantId);
  const { page, limit, skip } = paging(query);
  const [rows, total] = await Promise.all([
    Payout.find(f).sort({ createdAt: -1 }).skip(skip).limit(limit).populate(admin ? { path: "tenantId", select: "name slug" } : null).lean(),
    Payout.countDocuments(f),
  ]);
  const out = { data: rows.map((p) => presentPayout(p, { admin })), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
  if (admin) {
    const counts = await Payout.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
    out.counts = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  }
  return out;
}

/** Admin: full bank details to pay a manual payout (route is audited). */
export async function payoutBankDetails(id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError(404, "Payout not found", "NOT_FOUND");
  const p = await Payout.findById(id).select("tenantId").lean();
  if (!p) throw new AppError(404, "Payout not found", "NOT_FOUND");
  const tenant = await Tenant.findById(p.tenantId).select("name kyc.bank").lean();
  const b = tenant?.kyc?.bank || {};
  const accountNumber = await bankAccountNumber(tenant);
  if (!accountNumber) throw new AppError(409, "This store has no bank account on file", "NO_BANK_ACCOUNT");
  return { holderName: b.holderName || "", accountNumber, ifsc: b.ifsc || "", verified: Boolean(b.verified), storeName: tenant.name };
}

export async function getPayout(id, { tenantId = null, admin = false } = {}) {
  if (!mongoose.isValidObjectId(id)) throw new AppError(404, "Payout not found", "NOT_FOUND");
  const filter = { _id: id };
  if (tenantId) filter.tenantId = tenantId;
  const p = await Payout.findOne(filter).populate({ path: "tenantId", select: "name slug" }).lean();
  if (!p) throw new AppError(404, "Payout not found", "NOT_FOUND");
  const entries = await SellerLedgerEntry.find({ payoutId: p._id }).sort({ createdAt: 1 }).lean();
  const out = { ...presentPayout(p, { admin }), entries: entries.map(presentEntry) };
  if (admin && out.history?.length) {
    // "by" ids -> { id, name, email } so the history shows who acted.
    const refs = await loadUserRefs(out.history.map((h) => h.by));
    out.history = out.history.map((h) => ({ ...h, by: userRef(h.by, refs) }));
  }
  return out;
}

/* ------------------------------------------------------------------ subscription netting */

/**
 * Overdue subscription invoices of a past_due / paused store are paid out of the payout (whole
 * invoices only, oldest first, while the balance covers them): subscription_netting(−total) +
 * invoice marked paid (method 'netting') in one transaction. Returns paise netted.
 */
export async function netSubscriptionDues(tenantId, availablePaise, { by = null, now = new Date(), payoutRef = "" } = {}) {
  const { TenantSubscription } = await import("../billing/subscription.model.js");
  const { SubscriptionInvoice } = await import("../billing/invoice.model.js");
  const { settleInvoice } = await import("../billing/service.js");
  const sub = await TenantSubscription.findOne({ tenantId, status: { $in: ["past_due", "paused"] } }).lean();
  if (!sub) return 0;
  const invoices = await SubscriptionInvoice.find({ tenantId, status: "issued", dueAt: { $lte: now } }).sort({ dueAt: 1 }).lean();
  let left = availablePaise;
  let netted = 0;
  for (const inv of invoices) {
    const amount = toPaise(inv.total);
    if (!(amount > 0) || amount > left) break;
    const done = await withTransaction(async (session) => {
      const res = await settleInvoice(inv, { method: "netting", mode: "Netted from payout", reference: payoutRef || "Netted from seller payout", paidAt: now }, { by, session });
      if (res.already) return false;
      await writeEntries(
        [
          {
            tenantId: inv.tenantId,
            key: `netting:${inv._id}`,
            kind: "subscription_netting",
            amountPaise: -amount,
            subscriptionInvoiceId: inv._id,
            availableAt: now,
            memo: `Subscription invoice ${inv.number} paid from payout`,
            data: { invoiceNumber: inv.number },
            createdBy: by,
          },
        ],
        { session }
      );
      return true;
    }).catch((err) => {
      logger.error("payouts: subscription netting failed", { tenantId: String(tenantId), invoice: inv.number, err: err.message });
      return false;
    });
    if (done) {
      left -= amount;
      netted += amount;
    }
  }
  return netted;
}

/* ------------------------------------------------------------------ payout run */

function summarise(entries) {
  const sum = (kinds) => entries.filter((e) => kinds.includes(e.kind)).reduce((s, e) => s + e.amountPaise, 0);
  return {
    gross: { sales: sum(["sale"]), creditRepayments: sum(["credit_repayment"]), adjustments: sum(["adjustment", "payout"]) },
    deductions: {
      refunds: -sum(["refund"]),
      cod: -sum(["collected_by_seller"]),
      subscription: -sum(["subscription_netting"]),
      fees: -sum(["platform_fee", "partner_fee", "gateway_fee", "route_fee"]),
      tcs: -sum(["tcs", "tcs_reversal"]),
      tds: -sum(["tds", "tds_reversal"]),
    },
  };
}

function history(action, from, to, by = null, note = "") {
  return { $push: { history: { at: new Date(), action, from, to, by, note: String(note || "").slice(0, 500) } } };
}

/**
 * One payout for one store (job, or admin "run now"). Skips stores on hold or with a payout still
 * being processed / failed. Nets overdue subscription dues, then pays the available balance when it
 * reaches payouts.minAmount: Route mode (active linked account) releases the held transfers of the
 * final orders (after reversing any net debits from them) and sends the rest as a direct transfer;
 * otherwise a `pending_manual` payout for the platform to pay by bank transfer.
 * Returns { payout } | { skipped, availablePaise }.
 */
export async function runPayoutForTenant(tenantId, { by = null, now = new Date(), explicit = false } = {}) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
  if (tenant.payout?.onHold) {
    if (explicit) throw new AppError(409, "Payouts are on hold for this store", "PAYOUTS_ON_HOLD");
    return { skipped: "on_hold" };
  }
  const open = await Payout.findOne({ tenantId, status: { $in: ["processing", "failed"] }, recreditedAt: null }).select("number status").lean();
  if (open) {
    if (explicit) throw new AppError(409, `Payout ${open.number} is ${open.status}; retry or cancel it first`, "PAYOUT_OPEN");
    return { skipped: "open_payout" };
  }
  const settings = await payoutSettings();
  let { availablePaise } = await balanceFor(tenantId, { now });
  if (settings.netSubscriptionDues && availablePaise > 0) {
    availablePaise -= await netSubscriptionDues(tenantId, availablePaise, { by, now });
  }
  if (availablePaise <= 0 || availablePaise < settings.minAmountPaise) {
    return { skipped: availablePaise < 0 ? "negative_balance" : "below_minimum", availablePaise };
  }
  const mode = settings.mode === "route" && linkedAccountActive(tenant) ? "route" : "manual";
  // A bank-transfer payout needs somewhere to send the money; the balance carries forward.
  if (mode === "manual" && !(await bankAccountNumber(tenant))) {
    if (explicit) throw new AppError(409, "This store has no bank account on file", "NO_BANK_ACCOUNT");
    return { skipped: "no_bank_account", availablePaise };
  }
  const payoutId = await withTransaction(async (session) => {
    const entries = await SellerLedgerEntry.find({ tenantId: tenant._id, payoutId: null, availableAt: { $ne: null, $lte: now } }, null, { session }).lean();
    const amount = entries.reduce((s, e) => s + e.amountPaise, 0);
    if (amount <= 0 || amount < settings.minAmountPaise) return null;
    const number = await nextPayoutNumber(session);
    const { gross, deductions } = summarise(entries);
    const [payout] = await Payout.create(
      [
        {
          tenantId: tenant._id,
          number,
          amountPaise: amount,
          mode,
          status: "processing",
          entryIds: entries.map((e) => e._id),
          gross,
          deductions,
          createdBy: by,
          history: [{ at: new Date(), action: "created", from: "", to: "processing", by, note: explicit ? "Run by admin" : "Scheduled run" }],
        },
      ],
      { session }
    );
    const claimed = await SellerLedgerEntry.updateMany({ _id: { $in: entries.map((e) => e._id) }, payoutId: null }, { $set: { payoutId: payout._id } }, { session });
    if (claimed.modifiedCount !== entries.length) throw new AppError(409, "Ledger changed during the payout run; try again", "CONFLICT");
    return payout._id;
  });
  if (!payoutId) return { skipped: "below_minimum", availablePaise };
  const payout = await executePayout(payoutId);
  return { payout };
}

/** Plan the money movements of a payout once: per held transfer how much to reverse / release, plus a direct transfer. */
async function planTransfers(payout) {
  const entries = await SellerLedgerEntry.find({ payoutId: payout._id }).select("orderId").lean();
  const orderIds = [...new Set(entries.filter((e) => e.orderId).map((e) => String(e.orderId)))];
  const orders = await Order.find({ _id: { $in: orderIds }, "payout.transferStatus": "held", "payout.transferId": { $ne: "" } }).lean();
  const rows = orders.map((o) => ({ type: "order", transferId: o.payout.transferId, orderId: o._id, remaining: transferRemaining(o) }));
  const held = rows.reduce((s, r) => s + r.remaining, 0);
  if (payout.mode !== "route") {
    // Manual payout: money still sitting on held transfers comes back to the platform first.
    return rows.map((r) => ({ type: "order", transferId: r.transferId, orderId: r.orderId, releasedPaise: 0, reversedPaise: r.remaining, status: "pending" }));
  }
  let reverse = Math.max(0, held - payout.amountPaise);
  const sorted = [...rows].sort((a, b) => b.remaining - a.remaining);
  const plan = sorted.map((r) => {
    const take = Math.min(reverse, r.remaining);
    reverse -= take;
    return { type: "order", transferId: r.transferId, orderId: r.orderId, releasedPaise: r.remaining - take, reversedPaise: take, status: "pending" };
  });
  const releasing = plan.reduce((s, r) => s + r.releasedPaise, 0);
  const direct = payout.amountPaise - releasing;
  if (direct > 0) plan.push({ type: "direct", transferId: "", orderId: null, releasedPaise: direct, reversedPaise: 0, status: "pending" });
  return plan;
}

async function failPayout(payout, err, { by = null } = {}) {
  const reason = String(err?.message || err).slice(0, 500);
  const updated = await Payout.findOneAndUpdate(
    { _id: payout._id, status: "processing" },
    { $set: { status: "failed", failureReason: reason, transfers: payout.transfers }, ...history("failed", "processing", "failed", by, reason) },
    { new: true }
  );
  if (updated) emitDomain("PAYOUT_FAILED", { tenantId: updated.tenantId, payoutId: updated._id, number: updated.number, amountPaise: updated.amountPaise, reason, resource: "payout", resourceId: updated._id });
  return updated;
}

/** Mark a payout paid and write its payout(−amount) line (money left the platform). */
async function settlePaid(payoutId, { reference = "", paidAt = new Date(), by = null, from = ["processing"], note = "" } = {}) {
  return withTransaction(async (session) => {
    const current = await Payout.findById(payoutId, null, { session });
    const updated = await Payout.findOneAndUpdate(
      { _id: payoutId, status: { $in: from } },
      { $set: { status: "paid", paidAt, reference: String(reference || "").slice(0, 200), failureReason: "" }, ...history("paid", current?.status || "", "paid", by, note) },
      { new: true, session }
    );
    if (!updated) throw new AppError(409, `Payout is ${current?.status || "missing"}`, "INVALID_STATE");
    await writeEntries(
      [
        {
          tenantId: updated.tenantId,
          key: `payout:${updated._id}`,
          kind: "payout",
          amountPaise: -updated.amountPaise,
          payoutId: updated._id,
          availableAt: paidAt,
          memo: `Payout ${updated.number}${updated.reference ? ` (${updated.reference})` : ""}`,
          data: { mode: updated.mode, reference: updated.reference },
          createdBy: by,
        },
      ],
      { session }
    );
    const payload = { tenantId: updated.tenantId, payoutId: updated._id, number: updated.number, amountPaise: updated.amountPaise, reference: updated.reference, mode: updated.mode, resource: "payout", resourceId: updated._id };
    afterCommit(session, () => emitDomain("PAYOUT_PAID", payload));
    return updated;
  });
}

/**
 * Carry out a `processing` payout (also used by retry): reversals / releases of held transfers and
 * the direct transfer, each step recorded on payout.transfers so a retry continues where it stopped.
 * Route payouts end `paid`; manual ones end `pending_manual` (platform pays, then marks paid).
 */
export async function executePayout(payoutId, { by = null } = {}) {
  let payout = await Payout.findById(payoutId);
  if (!payout || payout.status !== "processing") return payout;
  const tenant = await Tenant.findById(payout.tenantId);
  try {
    if (!payout.transfers.length) {
      payout.transfers = await planTransfers(payout);
      await payout.save();
    }
    for (const row of payout.transfers) {
      if (row.type !== "order" || row.status !== "pending") continue;
      if (row.reversedPaise > 0) await reverseOrderTransfer(row.orderId, `payout:${payout._id}:${row.orderId}`, row.reversedPaise);
      if (row.releasedPaise > 0) {
        await releaseOrderTransfer(row.orderId, { payoutId: payout._id });
        row.status = "released";
      } else {
        await Order.updateOne({ _id: row.orderId }, { $set: { "payout.payoutId": payout._id } });
        row.status = "reversed";
      }
      payout.markModified("transfers");
      await payout.save();
    }
    const direct = payout.transfers.find((t) => t.type === "direct" && t.status === "pending");
    if (direct) {
      if (direct.error === "in_flight") {
        throw new AppError(409, "A direct transfer for this payout may already exist at Razorpay. Check the Razorpay dashboard, then mark the payout paid or cancel it.", "TRANSFER_UNKNOWN");
      }
      if (!linkedAccountActive(tenant)) throw new AppError(409, "The store's Razorpay linked account is not active", "ACCOUNT_INACTIVE");
      direct.error = "in_flight";
      payout.markModified("transfers");
      await payout.save();
      const res = await rzp.createDirectTransfer({
        account: tenant.payout.razorpayAccountId,
        amount: direct.releasedPaise,
        notes: { payout_id: String(payout._id), payout_number: payout.number, tenant_id: String(payout.tenantId) },
      });
      direct.transferId = res?.id || "";
      direct.status = res?.status === "failed" ? "failed" : "processed";
      direct.error = res?.status === "failed" ? String(res?.error?.description || "Transfer failed").slice(0, 300) : "";
      payout.markModified("transfers");
      await payout.save();
      if (direct.status === "failed") throw new AppError(502, `Direct transfer failed: ${direct.error}`, "PAYMENT_PROVIDER_ERROR");
    }
    if (payout.mode === "manual") {
      return Payout.findOneAndUpdate(
        { _id: payout._id, status: "processing" },
        { $set: { status: "pending_manual" }, ...history("awaiting_manual", "processing", "pending_manual", by, "Pay by bank transfer, then mark paid with the UTR") },
        { new: true }
      );
    }
    const refs = payout.transfers.filter((t) => t.transferId && t.status !== "reversed").map((t) => t.transferId);
    return settlePaid(payout._id, { reference: refs.join(",").slice(0, 200), by });
  } catch (err) {
    logger.error("payouts: payout failed", { payout: payout.number, err: err.message });
    payout = (await Payout.findById(payout._id)) || payout;
    return failPayout(payout, err, { by });
  }
}

/* ------------------------------------------------------------------ admin actions */

export async function markPayoutPaid(id, { reference, paidAt = null }, { by = null } = {}) {
  const payout = await Payout.findById(id);
  if (!payout) throw new AppError(404, "Payout not found", "NOT_FOUND");
  if (!["pending_manual", "failed"].includes(payout.status)) throw new AppError(409, `Payout is ${payout.status}`, "INVALID_STATE");
  const ref = String(reference || "").trim();
  if (!ref) throw new AppError(400, "Enter the payment reference (UTR)", "VALIDATION_ERROR");
  const at = paidAt ? new Date(paidAt) : new Date();
  if (Number.isNaN(at.getTime()) || at > new Date(Date.now() + 60 * 1000)) throw new AppError(400, "paidAt must be a date in the past", "VALIDATION_ERROR");
  await settlePaid(payout._id, { reference: ref, paidAt: at, by, from: ["pending_manual", "failed"], note: "Marked paid by admin" });
  return getPayout(payout._id, { admin: true });
}

export async function retryPayout(id, { by = null } = {}) {
  const payout = await Payout.findOneAndUpdate(
    { _id: id, status: "failed" },
    { $set: { status: "processing", failureReason: "" }, ...history("retry", "failed", "processing", by) },
    { new: true }
  );
  if (!payout) {
    const current = await Payout.findById(id).lean();
    if (!current) throw new AppError(404, "Payout not found", "NOT_FOUND");
    throw new AppError(409, `Only failed payouts can be retried (this one is ${current.status})`, "INVALID_STATE");
  }
  if (await SellerLedgerEntry.exists({ key: `payout:${payout._id}` })) {
    await Payout.updateOne({ _id: payout._id }, { $set: { status: "failed", failureReason: "Already paid and re-credited; the amount is paid in the next run" } });
    throw new AppError(409, "This payout was re-credited to the seller balance; it is paid in the next run", "INVALID_STATE");
  }
  await executePayout(payout._id, { by });
  return getPayout(payout._id, { admin: true });
}

export async function cancelPayout(id, { reason }, { by = null } = {}) {
  const payout = await Payout.findById(id);
  if (!payout) throw new AppError(404, "Payout not found", "NOT_FOUND");
  if (!["pending_manual", "failed"].includes(payout.status)) throw new AppError(409, `Payout is ${payout.status}`, "INVALID_STATE");
  if (payout.transfers.some((t) => ["released", "processed"].includes(t.status)) || (await SellerLedgerEntry.exists({ key: `payout:${payout._id}` }))) {
    throw new AppError(409, "Money already moved for this payout; it cannot be cancelled", "INVALID_STATE");
  }
  await withTransaction(async (session) => {
    const updated = await Payout.updateOne(
      { _id: payout._id, status: payout.status },
      { $set: { status: "cancelled", cancelReason: String(reason || "").slice(0, 500) }, ...history("cancelled", payout.status, "cancelled", by, reason) },
      { session }
    );
    if (!updated.modifiedCount) throw new AppError(409, "Payout changed; refresh and try again", "INVALID_STATE");
    // Lines go back to the balance (paid in the next run).
    await SellerLedgerEntry.updateMany({ payoutId: payout._id, kind: { $ne: "payout" } }, { $set: { payoutId: null } }, { session });
  });
  return getPayout(payout._id, { admin: true });
}

export async function setHold(tenantId, { reason }, { by = null } = {}) {
  const tenant = await Tenant.findByIdAndUpdate(
    tenantId,
    { $set: { "payout.onHold": { reason: String(reason || "").slice(0, 500), by, at: new Date() } } },
    { new: true }
  );
  if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
  emitDomain("PAYOUTS_HELD", { tenantId: tenant._id, reason: tenant.payout.onHold.reason, by, resource: "tenant", resourceId: tenant._id });
  return sellerOverview(tenant._id);
}

export async function releaseHold(tenantId) {
  const tenant = await Tenant.findByIdAndUpdate(tenantId, { $set: { "payout.onHold": null } }, { new: true });
  if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
  return sellerOverview(tenant._id);
}

/** Manual ± adjustment (INR), available at once. */
export async function addAdjustment(tenantId, { amount, reason }, { by = null } = {}) {
  const tenant = await Tenant.findById(tenantId).select("_id").lean();
  if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
  const paise = toPaise(amount);
  if (!paise) throw new AppError(400, "Amount must not be 0", "VALIDATION_ERROR");
  const key = `adjustment:${new mongoose.Types.ObjectId()}`;
  await writeEntries([{ tenantId: tenant._id, key, kind: "adjustment", amountPaise: paise, availableAt: new Date(), memo: String(reason).slice(0, 500), data: { reason: String(reason).slice(0, 500) }, createdBy: by }]);
  return presentEntry(await SellerLedgerEntry.findOne({ key }).lean());
}

/** Admin: per-store balances + account status. Filters q (name/slug), accountStatus, onHold, hasBalance. */
export async function adminSellers(query = {}) {
  const filter = {};
  if (query.q) {
    const rx = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 100), "i");
    filter.$or = [{ name: rx }, { slug: rx }, { "businessProfile.legalName": rx }];
  }
  if (query.accountStatus) filter["payout.status"] = { $in: String(query.accountStatus).split(",") };
  if (query.onHold === "true") filter["payout.onHold"] = { $ne: null };
  if (query.hasBalance === "true") {
    const rows = await SellerLedgerEntry.aggregate([
      { $match: { payoutId: null } },
      { $group: { _id: "$tenantId", total: { $sum: "$amountPaise" } } },
      { $match: { total: { $ne: 0 } } },
    ]);
    filter._id = { $in: rows.map((r) => r._id) };
  }
  const { page, limit, skip } = paging(query);
  const [tenants, total] = await Promise.all([
    Tenant.find(filter).select("name slug status payout kyc.bank.accountLast4 kyc.bank.ifsc kyc.bank.holderName").sort({ name: 1 }).skip(skip).limit(limit).lean(),
    Tenant.countDocuments(filter),
  ]);
  const now = new Date();
  const ids = tenants.map((t) => t._id);
  const sums = await SellerLedgerEntry.aggregate([
    { $match: { tenantId: { $in: ids }, payoutId: null } },
    {
      $group: {
        _id: "$tenantId",
        available: { $sum: { $cond: [{ $and: [{ $ne: ["$availableAt", null] }, { $lte: ["$availableAt", now] }] }, "$amountPaise", 0] } },
        held: { $sum: { $cond: [{ $eq: ["$availableAt", null] }, "$amountPaise", 0] } },
      },
    },
  ]);
  const pend = await Payout.aggregate([
    { $match: { tenantId: { $in: ids }, status: { $in: ["pending_manual", "processing", "failed"] }, recreditedAt: null } },
    { $group: { _id: "$tenantId", total: { $sum: "$amountPaise" }, n: { $sum: 1 } } },
  ]);
  const byId = new Map(sums.map((s) => [String(s._id), s]));
  const pById = new Map(pend.map((s) => [String(s._id), s]));
  return {
    data: tenants.map((t) => {
      const s = byId.get(String(t._id)) || { available: 0, held: 0 };
      const p = pById.get(String(t._id)) || { total: 0, n: 0 };
      return {
        tenantId: t._id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        balance: { availablePaise: Math.max(0, s.available), heldPaise: s.held, owedPaise: Math.max(0, -s.available), netAvailablePaise: s.available, pendingPayoutPaise: p.total },
        openPayouts: p.n,
        account: accountView(t),
        bank: bankView(t),
        hold: holdView(t),
      };
    }),
    meta: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

export async function adminSellerDetail(tenantId, query = {}) {
  const tenant = await Tenant.findById(tenantId).select("name slug status").lean();
  if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
  const [overview, ledger, payouts] = await Promise.all([
    sellerOverview(tenantId),
    listLedger(tenantId, query),
    listPayouts({ tenantId: tenant._id }, { limit: 20 }, { admin: true }),
  ]);
  if (overview.hold?.by) {
    const refs = await loadUserRefs([overview.hold.by]);
    overview.hold = { ...overview.hold, by: userRef(overview.hold.by, refs) };
  }
  return { tenant: { id: tenant._id, name: tenant.name, slug: tenant.slug, status: tenant.status }, ...overview, ledger, payouts: payouts.data };
}

export async function adminLinkedAccount(tenantId) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
  const p = tenant.payout || {};
  const updated = p.razorpayAccountId && p.productId && p.bankLinkedAt
    ? await syncLinkedAccount(tenant)
    : await createOrRefreshLinkedAccount(tenant._id, { throwOnError: false });
  return { account: accountView(updated), bank: bankView(updated) };
}

/* ------------------------------------------------------------------ jobs */

/**
 * Job `payouts`: repair sweep (orders missing from the ledger), held Route transfers still to
 * create, finality (release held lines), then — on schedule days — one payout per store with an
 * available balance.
 */
export async function runPayoutsJob({ now = new Date(), force = false } = {}) {
  const settings = await payoutSettings();
  const swept = await recordMissing();
  let transfers = 0;
  if (settings.mode === "route") {
    const pending = await Order.find({
      "payout.basis": "online",
      "payout.finalAt": null,
      "payout.transferStatus": { $in: ["", "pending", null] },
      razorpayPaymentId: { $ne: "" },
    })
      .select("_id")
      .limit(200)
      .lean();
    for (const o of pending) {
      try {
        if (await ensureOrderTransfer(o._id)) transfers += 1;
      } catch (err) {
        logger.error("payouts: transfer create failed", { orderId: String(o._id), err: err.message });
      }
    }
  }
  const finalised = await releaseFinalOrders({ now });
  const runDay = force || settings.schedule === "daily" || now.getUTCDay() === 1;
  const results = { paid: 0, pendingManual: 0, failed: 0, skipped: 0 };
  if (runDay) {
    const tenantIds = await SellerLedgerEntry.distinct("tenantId", { payoutId: null, availableAt: { $ne: null, $lte: now } });
    for (const tenantId of tenantIds) {
      try {
        const res = await runPayoutForTenant(tenantId, { now });
        if (res.payout?.status === "paid") results.paid += 1;
        else if (res.payout?.status === "pending_manual") results.pendingManual += 1;
        else if (res.payout?.status === "failed") results.failed += 1;
        else results.skipped += 1;
      } catch (err) {
        results.failed += 1;
        logger.error("payouts: run failed", { tenantId: String(tenantId), err: err.message });
      }
    }
  }
  return { swept, transfers, finalised, runDay, ...results };
}

/** Job `linked-accounts-sync`: poll Razorpay for linked accounts still under review. */
export async function runLinkedAccountsSync({ limit = 100 } = {}) {
  const tenants = await Tenant.find({
    "payout.razorpayAccountId": { $ne: "" },
    "payout.status": { $in: ["created", "under_review", "needs_clarification"] },
  }).limit(limit);
  let synced = 0;
  let activated = 0;
  for (const t of tenants) {
    try {
      const updated = t.payout.productId && t.payout.bankLinkedAt ? await syncLinkedAccount(t) : await createOrRefreshLinkedAccount(t._id);
      synced += 1;
      if (updated?.payout?.status === "activated") activated += 1;
    } catch (err) {
      logger.warn("payouts: linked account sync failed", { tenantId: String(t._id), err: err.message });
    }
  }
  return { synced, activated };
}
