import mongoose from "mongoose";
import { Order } from "../orders/order.model.js";
import { SellerLedgerEntry } from "./models.js";
import { payoutSettings, payoutsStartDate } from "./settings.js";
import { taxSettings, withholdingFor, withholdingForRefund } from "./tax.js";
import { remainingRefund, feeTotal } from "../orders/returns.js";
import { splitInclusive, FEE_TAX_RATE } from "../pricing/engine.js";
import { withTransaction, withSession } from "../../utils/transaction.js";
import { logger } from "../../utils/logger.js";

/**
 * Seller ledger recording (p4-payouts). Every line is written with an idempotency key through an
 * upsert ($setOnInsert), so replays (webhook + verify, job sweeps, transaction retries) never
 * double-count. Sign: + platform owes the seller, − seller owes the platform.
 *
 *  online paid   -> on payment: sale(+total), platform_fee(−), partner_fee(−), gateway_fee(−), tcs(−), tds(−); held
 *  COD courier   -> on delivery: same, held
 *  COD by seller -> on delivery: same, held + collected_by_seller(−total), also held (released with the sale)
 *  COD platform  -> (own rider, UPI QR to the platform) on delivery: like courier COD, held; never collected_by_seller
 *  credit / PO   -> on delivery: platform_fee / partner_fee / tcs / tds debits, available now (no sale)
 *  refunds       -> refund(−amount) (+ fee / TCS / TDS reversals for the refunded part)
 */

export const ONLINE_METHODS = ["upi", "card", "netbanking"];
export const CREDIT_METHODS = ["credit_terms", "purchase_order"];

export const toPaise = (rupees) => Math.round((Number(rupees) || 0) * 100 + 1e-7);
const idOf = (v) => v?._id || v || null;

/** Upsert entries by `key` inside `session`. Returns how many were new. */
export async function writeEntries(entries, { session = null } = {}) {
  let created = 0;
  for (const e of entries) {
    if (!e || !e.key || !Number.isFinite(e.amountPaise) || e.amountPaise === 0) continue;
    const doc = {
      tenantId: e.tenantId,
      key: e.key,
      kind: e.kind,
      amountPaise: Math.round(e.amountPaise),
      orderId: e.orderId || null,
      orderNumber: e.orderNumber || "",
      refundRef: e.refundRef || "",
      payoutId: e.payoutId || null,
      transferId: e.transferId || "",
      subscriptionInvoiceId: e.subscriptionInvoiceId || null,
      availableAt: e.availableAt || null,
      heldReason: e.availableAt ? "" : e.heldReason || "Held until the order is final",
      memo: e.memo || "",
      data: e.data || {},
      createdBy: e.createdBy || null,
      createdAt: e.createdAt || new Date(),
    };
    const res = await SellerLedgerEntry.updateOne({ key: e.key }, { $setOnInsert: doc }, withSession(session, { upsert: true }));
    if (res.upsertedCount) created += 1;
  }
  return created;
}

function base(order, extra = {}) {
  return { tenantId: idOf(order.tenantId), orderId: order._id, orderNumber: order.orderNumber || "", ...extra };
}

/** Deduction lines shared by every basis: platform fee, platform courier fee, TCS, TDS (all −). */
function deductionEntries(order, { tax, availableAt, feeMemo = "" }) {
  const id = String(order._id);
  const out = [];
  const platformFee = toPaise(order.platformFee);
  const partnerFee = toPaise(order.partnerFee);
  if (platformFee > 0) out.push(base(order, { key: `platform_fee:${id}`, kind: "platform_fee", amountPaise: -platformFee, availableAt, memo: `Platform fee ${order.orderNumber}${feeMemo}` }));
  if (partnerFee > 0) {
    out.push(
      base(order, {
        key: `partner_fee:${id}`,
        kind: "partner_fee",
        amountPaise: -partnerFee,
        availableAt,
        memo: `Delivery partner fee ${order.orderNumber}${order.deliveryPartner?.name ? ` (${order.deliveryPartner.name})` : ""}`,
      })
    );
  }
  if (tax.tcs.total > 0) {
    out.push(
      base(order, {
        key: `tcs:${id}`,
        kind: "tcs",
        amountPaise: -tax.tcs.total,
        availableAt,
        memo: `GST TCS on ${order.orderNumber}`,
        data: { base: tax.base, supplyType: tax.supplyType, igst: tax.tcs.igst, cgst: tax.tcs.cgst, sgst: tax.tcs.sgst },
      })
    );
  }
  if (tax.tds > 0) {
    out.push(base(order, { key: `tds:${id}`, kind: "tds", amountPaise: -tax.tds, availableAt, memo: `TDS 194-O on ${order.orderNumber}`, data: { base: tax.base } }));
  }
  return out;
}

/**
 * Claim the order for recording (payout.recordedAt null -> now) and write its lines + catch up any
 * refunds already on the order (recorded before the order was on the ledger). Own transaction
 * unless `session` is given.
 */
async function recordOrder(order, { basis, extraEntries = [], session = null, settings = null, tax = null }) {
  const run = async (s) => {
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, "payout.recordedAt": null },
      { $set: { "payout.recordedAt": new Date(), "payout.basis": basis } },
      withSession(s, { new: true })
    );
    if (!claimed) return false;
    const now = new Date();
    const held = basis === "credit" ? now : null;
    const entries = [];
    if (basis !== "credit") {
      entries.push(
        base(claimed, {
          key: `sale:${claimed._id}`,
          kind: "sale",
          amountPaise: toPaise(claimed.total),
          availableAt: null,
          memo: `Order ${claimed.orderNumber}`,
          data: { basis, taxableValuePaise: tax.base, paymentMethod: claimed.paymentMethod },
        })
      );
    }
    entries.push(...deductionEntries(claimed, { tax, availableAt: held }));
    entries.push(...extraEntries.map((e) => base(claimed, e)));
    await writeEntries(entries, { session: s });
    // Refunds queued before this order was on the ledger (e.g. recorded late by the sweep).
    for (const row of claimed.refunds || []) await recordRefundEntries(claimed, row, { session: s, settings, recorded: true });
    return true;
  };
  return session ? run(session) : withTransaction(run);
}

async function startOk(date) {
  if (!date) return true;
  const start = await payoutsStartDate();
  return new Date(date) >= start;
}

/* ------------------------------------------------------------------ online payments */

/**
 * Online payment captured (markRazorpayPaid): record every seller order paid by `paymentId`.
 * `payment` (Razorpay entity, optional) supplies `fee` (paise, incl. GST) for gateway_fee lines,
 * allocated pro-rata by order total over the orders of the payment (last one takes the rest).
 * Returns the orders recorded now. Never throws for one bad order (logged; the job sweep retries).
 */
export async function recordOnlinePayment(paymentId, payment = null) {
  if (!paymentId) return [];
  const group = await Order.find({ razorpayPaymentId: paymentId, paymentStatus: { $in: ["paid", "refunded"] } }).sort({ _id: 1 });
  if (!group.length) return [];
  const settings = await payoutSettings();
  const tax = await taxSettings();
  let fee = 0;
  if (settings.passGatewayFees) {
    let entity = payment;
    if (!(Number(entity?.fee) >= 0) || entity?.fee == null) {
      try {
        const { fetchPayment, razorpayConfigured } = await import("../checkout/razorpayApi.js");
        if (razorpayConfigured()) entity = await fetchPayment(paymentId);
      } catch (err) {
        logger.warn("payouts: payment fee lookup failed", { paymentId, err: err.message });
      }
    }
    fee = Math.max(0, Math.round(Number(entity?.fee) || 0));
  }
  const eligible = group.filter((o) => ONLINE_METHODS.includes(o.paymentMethod) && !(o.refunds || []).some((r) => r.key === `${o._id}:late-payment`));
  const totalPaise = eligible.reduce((s, o) => s + toPaise(o.total), 0);
  const recorded = [];
  let allocated = 0;
  for (let i = 0; i < eligible.length; i += 1) {
    const order = eligible[i];
    const share = i === eligible.length - 1 ? fee - allocated : totalPaise > 0 ? Math.round((fee * toPaise(order.total)) / totalPaise) : 0;
    allocated += share;
    if (order.payout?.recordedAt) continue;
    if (!(await startOk(order.paidAt || order.createdAt))) continue;
    try {
      const extra = [];
      if (share > 0) {
        extra.push({
          key: `gateway_fee:${order._id}`,
          kind: "gateway_fee",
          amountPaise: -share,
          availableAt: null,
          memo: `Payment gateway fee ${order.orderNumber}`,
          data: { paymentId, paymentFeePaise: fee, paymentTaxPaise: Math.max(0, Math.round(Number(payment?.tax) || 0)) },
        });
      }
      const ok = await recordOrder(order, { basis: "online", extraEntries: extra, settings, tax: withholdingFor(order, tax) });
      if (ok) recorded.push(order._id);
    } catch (err) {
      logger.error("payouts: recording online order failed", { order: order.orderNumber, err: err.message });
    }
  }
  if (recorded.length && settings.mode === "route") {
    const { ensureOrderTransfer } = await import("./route.js");
    for (const id of recorded) {
      await ensureOrderTransfer(id).catch((err) => logger.error("payouts: route transfer failed", { orderId: String(id), err: err.message }));
    }
  }
  return recorded;
}

/* ------------------------------------------------------------------ delivery (COD / credit) */

/**
 * Order delivered (advanceOrder, inside its transaction). COD: sale + deductions held, plus
 * collected_by_seller(−total) when the seller's own rider / pickup collected the cash — held too,
 * released with the sale when the order is final. Credit / PO: fee + tax debits available at once (the money arrives via repayments).
 */
export async function recordDelivery(order, { session = null } = {}) {
  if (!order || order.payout?.recordedAt) return false;
  const isCod = order.paymentMethod === "cod";
  const isCredit = CREDIT_METHODS.includes(order.paymentMethod);
  if (!isCod && !isCredit) return false;
  if (!(await startOk(order.deliveredAt || new Date()))) return false;
  const settings = await payoutSettings();
  const tax = withholdingFor(order, await taxSettings());
  if (isCredit) return recordOrder(order, { basis: "credit", session, settings, tax });
  const bySeller = order.codCollection?.by === "seller";
  const extra = bySeller
    ? [
        {
          key: `collected_by_seller:${order._id}`,
          kind: "collected_by_seller",
          amountPaise: -toPaise(order.codCollection?.amount || order.total),
          // Held with the sale: both are released together when the order is final, so the store
          // never sees a temporary "owed to platform" for cash its own rider collected.
          availableAt: null,
          memo: `COD cash collected by the store for ${order.orderNumber}`,
        },
      ]
    : [];
  // "platform" (phase 5 UPI QR): the money is already with the platform, like courier COD.
  const basis = bySeller ? "cod_seller" : order.codCollection?.by === "platform" ? "cod_platform" : "cod_courier";
  return recordOrder(order, { basis, extraEntries: extra, session, settings, tax });
}

/* ------------------------------------------------------------------ refunds */

/**
 * Split a refund row into seller value and fees (paise):
 *   { refundPaise, feePaise, platformPaise, partnerPaise, deliveryPaise, taxablePaise }.
 * Return refunds use the return record; cancel / RTO / full refunds what is still unrefunded.
 */
export function refundSplit(order, row) {
  const refundPaise = toPaise(row.amount);
  const key = String(row.key || "");
  let itemsTaxable = 0;
  let itemsAmount = 0;
  let fees = 0;
  const m = key.match(/:return:([a-f\d]{24})$/i);
  const ret = m ? (order.returns || []).find((r) => String(r._id) === m[1]) : null;
  if (ret) {
    itemsAmount = Number(ret.itemsAmount) || 0;
    fees = Number(ret.feesAmount) || 0;
    itemsTaxable = (ret.items || []).reduce((s, i) => s + (Number(i.taxableValue) || 0), 0);
  } else {
    const rem = remainingRefund(order);
    itemsAmount = rem.items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    fees = rem.feesAmount;
    itemsTaxable = rem.items.reduce((s, i) => s + (Number(i.taxableValue) || 0), 0);
  }
  const full = toPaise(itemsAmount + fees);
  const scale = full > 0 ? Math.min(1, refundPaise / full) : 0;
  const feePaise = Math.min(refundPaise, Math.round(toPaise(fees) * scale));
  const total = feeTotal(order);
  const share = (part) => (total > 0 ? Math.round((feePaise * (Number(part) || 0)) / total) : 0);
  const deliveryPaise = share(order.deliveryFee);
  const partnerPaise = share(order.partnerFee);
  const platformPaise = Math.max(0, feePaise - deliveryPaise - partnerPaise);
  const deliveryTaxable = deliveryPaise > 0 ? toPaise(splitInclusive(deliveryPaise / 100, FEE_TAX_RATE).taxableValue) : 0;
  const taxablePaise = Math.round(toPaise(itemsTaxable) * scale) + deliveryTaxable;
  return { refundPaise, feePaise, platformPaise: (Number(order.platformFee) || 0) > 0 ? platformPaise : 0, partnerPaise, deliveryPaise, taxablePaise };
}

async function sumsByKind(orderId, session) {
  const rows = await SellerLedgerEntry.aggregate([
    { $match: { orderId: new mongoose.Types.ObjectId(String(orderId)) } },
    { $group: { _id: "$kind", total: { $sum: "$amountPaise" } } },
  ]).session(session || null);
  return Object.fromEntries(rows.map((r) => [r._id, r.total]));
}

/**
 * Ledger lines for one refund row of a recorded order (no-op for stray / mismatch / late-payment
 * refunds and for orders not on the ledger). Online / COD: refund(−amount) + platform / partner fee
 * reversal (+ the fee share the buyer got back) + TCS / TDS reversal (+) on the refunded seller
 * taxable value. Credit / PO (no sale line): only the fee and tax reversals. Reversals are capped
 * by what was withheld. Held while the order is not final, available at once after.
 */
export async function recordRefundEntries(order, row, { session = null, settings = null, recorded = false } = {}) {
  if (!row?.key || /^(stray|mismatch):/.test(row.key) || /:late-payment$/.test(row.key)) return 0;
  const fresh = recorded ? order : await Order.findById(order._id, null, withSession(session));
  if (!fresh?.payout?.recordedAt) return 0;
  const id = String(fresh._id);
  const split = refundSplit(fresh, row);
  if (!(split.refundPaise > 0)) return 0;
  const tax = withholdingForRefund(fresh, { taxablePaise: split.taxablePaise, taxableValuePaise: split.taxablePaise }, await taxSettings());
  const sums = await sumsByKind(fresh._id, session);
  const cap = (kind, reversed, want) => Math.max(0, Math.min(want, -(sums[kind] || 0) - (sums[reversed] || 0)));
  const availableAt = fresh.payout.finalAt || fresh.payout.basis === "credit" ? new Date() : null;
  const ref = row.key;
  const entries = [];
  if (fresh.payout.basis !== "credit") {
    entries.push(
      base(fresh, {
        key: `refund:${id}:${ref}`,
        kind: "refund",
        amountPaise: -split.refundPaise,
        refundRef: ref,
        availableAt,
        memo: `Refund ${fresh.orderNumber}${row.reason ? `: ${String(row.reason).slice(0, 120)}` : ""}`,
        data: { method: row.method || "razorpay", sellerPaise: split.refundPaise - split.platformPaise - split.partnerPaise, feePaise: split.feePaise },
      })
    );
  }
  // Fee reversals: platform_fee / partner_fee rows with a + amount (keyed per refund).
  const platformBack = Math.min(split.platformPaise, Math.max(0, -(sums.platform_fee || 0)));
  const partnerBack = Math.min(split.partnerPaise, Math.max(0, -(sums.partner_fee || 0)));
  if (platformBack > 0) entries.push(base(fresh, { key: `platform_fee:${id}:${ref}`, kind: "platform_fee", amountPaise: platformBack, refundRef: ref, availableAt, memo: `Platform fee refunded ${fresh.orderNumber}` }));
  if (partnerBack > 0) entries.push(base(fresh, { key: `partner_fee:${id}:${ref}`, kind: "partner_fee", amountPaise: partnerBack, refundRef: ref, availableAt, memo: `Delivery partner fee refunded ${fresh.orderNumber}` }));
  const tcsBack = cap("tcs", "tcs_reversal", tax.tcs.total);
  if (tcsBack > 0) {
    const ratio = tax.tcs.total > 0 ? tcsBack / tax.tcs.total : 0;
    entries.push(
      base(fresh, {
        key: `tcs_reversal:${id}:${ref}`,
        kind: "tcs_reversal",
        amountPaise: tcsBack,
        refundRef: ref,
        availableAt,
        memo: `GST TCS reversed (refund ${fresh.orderNumber})`,
        data: {
          base: tax.base,
          supplyType: tax.supplyType,
          igst: Math.round(tax.tcs.igst * ratio),
          cgst: Math.round(tax.tcs.cgst * ratio),
          sgst: tcsBack - Math.round(tax.tcs.igst * ratio) - Math.round(tax.tcs.cgst * ratio),
        },
      })
    );
  }
  const tdsBack = cap("tds", "tds_reversal", tax.tds);
  if (tdsBack > 0) entries.push(base(fresh, { key: `tds_reversal:${id}:${ref}`, kind: "tds_reversal", amountPaise: tdsBack, refundRef: ref, availableAt, memo: `TDS reversed (refund ${fresh.orderNumber})`, data: { base: tax.base } }));
  return writeEntries(entries, { session });
}

/** Hook for refunds.js (inside the refund's transaction). Never breaks the refund itself. */
export async function onRefundQueued(order, row, { session = null } = {}) {
  try {
    return await recordRefundEntries(order, row, { session });
  } catch (err) {
    if (session && /WriteConflict|TransientTransaction/.test(String(err?.message))) throw err;
    logger.error("payouts: refund ledger lines failed", { orderId: String(order?._id), key: row?.key, err: err.message });
    return 0;
  }
}

/* ------------------------------------------------------------------ finality */

/** When an order's held lines may be released: max(return deadline, deliveredAt + hold days). */
export function finalAtFor(order, { returnsEnabled = true, returnWindowDays = 7, holdDaysAfterDelivery = 7 } = {}) {
  const delivered = order.deliveredAt ? new Date(order.deliveredAt) : null;
  if (!delivered) return null;
  const DAY = 24 * 60 * 60 * 1000;
  const returnable = returnsEnabled && (order.items || []).some((i) => i.easyReturn);
  const returnUntil = returnable ? delivered.getTime() + returnWindowDays * DAY : 0;
  return new Date(Math.max(returnUntil, delivered.getTime() + holdDaysAfterDelivery * DAY));
}

/**
 * Job step: orders that became FINAL (delivered / fully returned / refunded after delivery,
 * return window + hold passed, no open return, no open dispute) get `payout.finalAt` and their held lines
 * released (availableAt = now). Cancelled / RTO orders are never final (their lines net to 0).
 */
export async function releaseFinalOrders({ now = new Date(), limit = 500 } = {}) {
  const settings = await payoutSettings();
  const { getCommerceSettings } = await import("../settings/commerce.js");
  const commerce = await getCommerceSettings(null);
  const opts = { returnsEnabled: commerce.returnsEnabled, returnWindowDays: commerce.returnWindowDays, holdDaysAfterDelivery: settings.holdDaysAfterDelivery };
  const candidates = await Order.find({
    "payout.recordedAt": { $ne: null },
    "payout.finalAt": null,
    status: { $in: ["delivered", "returned", "refunded"] },
    deliveredAt: { $ne: null, $lte: now },
    // An open dispute (phase 6) holds the order like an open return.
    returns: { $not: { $elemMatch: { $or: [{ status: { $in: ["requested", "approved"] } }, { disputeOpen: true }] } } },
  })
    .sort({ deliveredAt: 1 })
    .limit(limit);
  let released = 0;
  for (const order of candidates) {
    const at = finalAtFor(order, opts);
    if (!at || at > now) continue;
    await withTransaction(async (session) => {
      const done = await Order.updateOne(
        { _id: order._id, "payout.finalAt": null, status: { $in: ["delivered", "returned", "refunded"] } },
        { $set: { "payout.finalAt": now } },
        { session }
      );
      if (!done.modifiedCount) return;
      await SellerLedgerEntry.updateMany({ orderId: order._id, availableAt: null }, { $set: { availableAt: now, heldReason: "" } }, { session });
      released += 1;
    });
  }
  return released;
}

/* ------------------------------------------------------------------ repair sweep */

/**
 * Job step: orders that should be on the ledger but are not (recording failed after payment, or
 * webhook-less flows): online paid orders and delivered COD / credit orders since the start date.
 */
export async function recordMissing({ limit = 200 } = {}) {
  const start = await payoutsStartDate();
  const online = await Order.find({
    "payout.recordedAt": null,
    paymentMethod: { $in: ONLINE_METHODS },
    paymentStatus: { $in: ["paid", "refunded"] },
    razorpayPaymentId: { $nin: ["", null] },
    paidAt: { $gte: start },
  })
    .select("razorpayPaymentId")
    .limit(limit)
    .lean();
  let online2 = 0;
  for (const pid of [...new Set(online.map((o) => o.razorpayPaymentId))]) {
    online2 += (await recordOnlinePayment(pid).catch(() => [])).length;
  }
  const delivered = await Order.find({
    "payout.recordedAt": null,
    paymentMethod: { $in: ["cod", ...CREDIT_METHODS] },
    deliveredAt: { $gte: start },
  }).limit(limit);
  let offline = 0;
  for (const order of delivered) {
    try {
      if (await recordDelivery(order)) offline += 1;
    } catch (err) {
      logger.error("payouts: recording delivered order failed", { order: order.orderNumber, err: err.message });
    }
  }
  return { online: online2, offline };
}

/* ------------------------------------------------------------------ balances */

/** { availablePaise (signed net of available unpaid lines), heldPaise, lastEntryAt } for one store. */
export async function balanceFor(tenantId, { now = new Date() } = {}) {
  const tid = new mongoose.Types.ObjectId(String(tenantId));
  const [row] = await SellerLedgerEntry.aggregate([
    { $match: { tenantId: tid, payoutId: null } },
    {
      $group: {
        _id: null,
        available: { $sum: { $cond: [{ $and: [{ $ne: ["$availableAt", null] }, { $lte: ["$availableAt", now] }] }, "$amountPaise", 0] } },
        held: { $sum: { $cond: [{ $eq: ["$availableAt", null] }, "$amountPaise", 0] } },
      },
    },
  ]);
  return { availablePaise: row?.available || 0, heldPaise: row?.held || 0 };
}
