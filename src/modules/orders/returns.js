import { round2, splitInclusive } from "../pricing/engine.js";
import { AppError } from "../../utils/AppError.js";
import { isStrayRefundKey } from "../checkout/refunds.js";

/**
 * Pure helpers for item-level returns and partial refunds (no DB access).
 *
 * Money rules:
 *  - a line's value = its GST-inclusive total minus its coupon share (same as the invoice line);
 *  - a return refunds the returned units' share of that value; the last units of a line get the
 *    remainder so a fully returned line refunds exactly its invoice value;
 *  - seller-fault returns also refund the fees (delivery / partner / platform) in proportion to
 *    the seller-fault item value returned so far; buyer-choice returns refund item value only.
 */

export const ACTIVE_RETURN_STATUSES = ["requested", "approved"];

const idStr = (v) => String(v?._id || v || "");

/** Orders placed before per-line coupon shares put the whole coupon on the last line (as the invoice does). */
function legacyCouponLine(order) {
  const items = order.items || [];
  if (!order.couponDiscount || items.some((i) => i.couponShare)) return null;
  return items.length ? idStr(items[items.length - 1]._id) : null;
}

/** { amount, taxableValue, tax } of a whole order line, identical to its invoice line. */
export function lineValue(order, item) {
  const gross = round2(item.lineSubtotal ?? (item.unitPrice || 0) * (item.qty || 0));
  if (legacyCouponLine(order) === idStr(item._id)) {
    const amount = round2(gross - (order.couponDiscount || 0));
    const { taxableValue, tax } = splitInclusive(amount, item.taxRate || 0);
    return { amount, taxableValue, tax };
  }
  const amount = round2(gross - (item.couponShare || 0));
  if (item.taxableValue != null) return { amount, taxableValue: round2(item.taxableValue), tax: round2(item.tax || 0) };
  const { taxableValue, tax } = splitInclusive(amount, item.taxRate || 0);
  return { amount, taxableValue, tax };
}

export function feeTotal(order) {
  return round2((order.deliveryFee || 0) + (order.platformFee || 0) + (order.partnerFee || 0));
}

export function itemsTotal(order) {
  return round2((order.items || []).reduce((s, item) => s + lineValue(order, item).amount, 0));
}

/** Totals already refunded through received returns, per line and for fees. */
export function receivedReturnTotals(order) {
  const perLine = new Map();
  let fees = 0;
  let sellerFaultItems = 0;
  for (const r of order.returns || []) {
    if (r.status !== "received") continue;
    fees += r.feesAmount || 0;
    if (r.sellerFault) sellerFaultItems += r.itemsAmount || 0;
    for (const it of r.items || []) {
      const key = idStr(it.itemId);
      const row = perLine.get(key) || { qty: 0, amount: 0, taxableValue: 0, tax: 0 };
      row.qty += it.qty || 0;
      row.amount += it.amount || 0;
      row.taxableValue += it.taxableValue || 0;
      row.tax += it.tax || 0;
      perLine.set(key, row);
    }
  }
  return { perLine, fees: round2(fees), sellerFaultItems: round2(sellerFaultItems) };
}

/** Phase 6: closed return outcomes the buyer can dispute (their units cannot be requested again). */
export const BLOCKING_CLOSED_STATUSES = ["rejected", "qc_rejected", "pickup_failed"];

/**
 * Units per line that are in an active return, a rejected / QC-rejected / pickup-failed return, or
 * were rejected at the quality check of a received return (cannot be requested again; the buyer
 * disputes them instead). A record reopened by a dispute is skipped: its replacement counts.
 */
function blockedQty(order) {
  const out = new Map();
  const add = (itemId, qty) => out.set(idStr(itemId), (out.get(idStr(itemId)) || 0) + (qty || 0));
  for (const r of order.returns || []) {
    if (r.reopenedAs) continue;
    if (ACTIVE_RETURN_STATUSES.includes(r.status) || r.status === "rejected" || r.status === "pickup_failed") {
      for (const it of r.items || []) add(it.itemId, it.qty);
    } else if (r.status === "qc_rejected" || r.status === "received") {
      for (const it of r.qc?.items || []) add(it.itemId, it.qty);
    }
  }
  return out;
}

export function activeReturn(order) {
  return (order.returns || []).find((r) => ACTIVE_RETURN_STATUSES.includes(r.status)) || null;
}

/**
 * Lines the buyer can still return: [{ itemId, name, qty (ordered), returnedQty, returnableQty }].
 * Only "easy return" lines; qty <= delivered − already returned − in an active/rejected return.
 * A legacy order whose single returnRequest was already used has nothing returnable.
 */
export function returnableLines(order, { requireEasyReturn = true } = {}) {
  if (!(order.returns || []).length && order.returnRequest?.status) return [];
  const blocked = blockedQty(order);
  return (order.items || [])
    .filter((item) => item.easyReturn || !requireEasyReturn)
    .map((item) => {
      const id = idStr(item._id);
      const returnableQty = Math.max(0, (item.qty || 0) - (item.returnedQty || 0) - (blocked.get(id) || 0));
      return { itemId: item._id, name: item.name, qty: item.qty, returnedQty: item.returnedQty || 0, returnableQty };
    })
    .filter((row) => row.returnableQty > 0);
}

/**
 * Validate a buyer's selection against the returnable lines. No `items` = every returnable unit.
 * Returns [{ itemId, qty }] (merged per line).
 */
export function pickReturnItems(order, items, { requireEasyReturn = true } = {}) {
  const lines = returnableLines(order, { requireEasyReturn });
  if (!lines.length) throw new AppError(400, "None of the items in this order can be returned", "NOT_RETURNABLE");
  if (!items || !items.length) return lines.map((l) => ({ itemId: l.itemId, qty: l.returnableQty }));
  const wanted = new Map();
  for (const row of items) {
    const key = idStr(row.itemId);
    wanted.set(key, (wanted.get(key) || 0) + Number(row.qty || 0));
  }
  const out = [];
  for (const [key, qty] of wanted) {
    const item = (order.items || []).find((i) => idStr(i._id) === key);
    if (!item) throw new AppError(400, `Unknown order item ${key}`, "VALIDATION_ERROR");
    const line = lines.find((l) => idStr(l.itemId) === key);
    if (!line) throw new AppError(400, `${item.name || "This item"} cannot be returned`, "NOT_RETURNABLE");
    if (!Number.isInteger(qty) || qty < 1) throw new AppError(400, "Return qty must be a positive whole number", "VALIDATION_ERROR");
    if (qty > line.returnableQty) {
      throw new AppError(400, `Only ${line.returnableQty} unit(s) of ${item.name || "this item"} can be returned`, "RETURN_QTY_EXCEEDED");
    }
    out.push({ itemId: item._id, qty });
  }
  return out;
}

/**
 * Value a return: per-line refund amounts (with the remainder rule) and the fee share.
 * `items` = [{ itemId, qty, damagedQty? }]. Returns
 * { items: [{ itemId, name, qty, damagedQty, amount, taxableValue, tax }], itemsAmount, feesAmount, refundAmount }.
 */
export function valueReturn(order, items, { sellerFault = false } = {}) {
  const prev = receivedReturnTotals(order);
  const out = [];
  for (const row of items) {
    const item = (order.items || []).find((i) => idStr(i._id) === idStr(row.itemId));
    if (!item) throw new AppError(400, `Unknown order item ${idStr(row.itemId)}`, "VALIDATION_ERROR");
    const whole = lineValue(order, item);
    const before = prev.perLine.get(idStr(item._id)) || { qty: 0, amount: 0, taxableValue: 0, tax: 0 };
    const qty = Number(row.qty) || 0;
    let amount;
    let taxableValue;
    if (before.qty + qty >= item.qty) {
      amount = round2(whole.amount - before.amount);
      taxableValue = round2(whole.taxableValue - before.taxableValue);
    } else {
      amount = round2((whole.amount * qty) / item.qty);
      taxableValue = round2((whole.taxableValue * qty) / item.qty);
    }
    out.push({
      itemId: item._id,
      name: item.name || "",
      qty,
      damagedQty: Math.max(0, Math.min(qty, Number(row.damagedQty) || 0)),
      amount,
      taxableValue,
      tax: round2(amount - taxableValue),
    });
  }
  const itemsAmount = round2(out.reduce((s, r) => s + r.amount, 0));
  let feesAmount = 0;
  const fees = feeTotal(order);
  const base = itemsTotal(order);
  if (sellerFault && fees > 0 && base > 0) {
    const cumulative = round2(prev.sellerFaultItems + itemsAmount);
    const due = cumulative + 0.005 >= base ? fees : round2((fees * cumulative) / base);
    feesAmount = Math.max(0, Math.min(round2(fees - prev.fees), round2(due - prev.fees)));
  }
  return { items: out, itemsAmount, feesAmount, refundAmount: round2(itemsAmount + feesAmount) };
}

/** True when, after `items` come back, every unit of every line has been returned. */
export function fullyReturnedAfter(order, items) {
  const adding = new Map();
  for (const it of items || []) adding.set(idStr(it.itemId), (adding.get(idStr(it.itemId)) || 0) + (it.qty || 0));
  return (order.items || []).every((item) => (item.returnedQty || 0) + (adding.get(idStr(item._id)) || 0) >= item.qty);
}

/**
 * What a full refund still has to cover after earlier partial returns:
 * { partial: boolean, items: [...valued lines], feesAmount, amount }.
 */
export function remainingRefund(order) {
  const prev = receivedReturnTotals(order);
  const partial = prev.perLine.size > 0 || prev.fees > 0;
  const items = [];
  for (const item of order.items || []) {
    const before = prev.perLine.get(idStr(item._id)) || { qty: 0, amount: 0, taxableValue: 0, tax: 0 };
    const qty = (item.qty || 0) - before.qty;
    if (qty <= 0) continue;
    const whole = lineValue(order, item);
    const amount = round2(whole.amount - before.amount);
    const taxableValue = round2(whole.taxableValue - before.taxableValue);
    items.push({ itemId: item._id, name: item.name || "", qty, damagedQty: 0, amount, taxableValue, tax: round2(amount - taxableValue) });
  }
  const feesAmount = Math.max(0, round2(feeTotal(order) - prev.fees));
  const amount = round2(items.reduce((s, r) => s + r.amount, 0) + feesAmount);
  return { partial, items, feesAmount, amount };
}

/** Money already promised back to the buyer on this order (every non-stray refund record). */
export function refundedSoFar(order) {
  return round2((order.refunds || []).filter((r) => !isStrayRefundKey(r.key)).reduce((s, r) => s + (r.amount || 0), 0));
}

/* ------------------------------------------------------- refund destination */

const UPI_RX = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
const IFSC_RX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RX = /^\d{9,18}$/;

/** Validate + normalise a refund destination. null/empty input -> null. Throws 400 on bad data. */
export function normalizeDestination(input) {
  if (!input || !input.type) return null;
  const type = String(input.type);
  if (type === "store_credit") return { type, upiId: "", accountName: "", accountNumber: "", ifsc: "" };
  if (type === "upi") {
    const upiId = String(input.upiId || "").trim();
    if (!UPI_RX.test(upiId)) throw new AppError(400, "Enter a valid UPI id (name@bank)", "VALIDATION_ERROR");
    return { type, upiId, accountName: String(input.accountName || "").trim().slice(0, 100), accountNumber: "", ifsc: "" };
  }
  if (type === "bank") {
    const accountNumber = String(input.accountNumber || "").replace(/\s+/g, "");
    const ifsc = String(input.ifsc || "").trim().toUpperCase();
    const accountName = String(input.accountName || "").trim().slice(0, 100);
    if (!ACCOUNT_RX.test(accountNumber)) throw new AppError(400, "Enter a valid bank account number (9-18 digits)", "VALIDATION_ERROR");
    if (!IFSC_RX.test(ifsc)) throw new AppError(400, "Enter a valid IFSC code", "VALIDATION_ERROR");
    if (!accountName) throw new AppError(400, "Enter the account holder's name", "VALIDATION_ERROR");
    return { type, upiId: "", accountName, accountNumber, ifsc };
  }
  throw new AppError(400, "Refund destination must be upi, bank or store_credit", "VALIDATION_ERROR");
}

/** Hide all but the last 4 digits of a bank account (sellers never need the full number). */
export function maskDestination(dest) {
  if (!dest || !dest.accountNumber) return dest;
  const plain = typeof dest.toObject === "function" ? dest.toObject() : { ...dest };
  plain.accountNumber = `XXXX${String(plain.accountNumber).slice(-4)}`;
  return plain;
}
