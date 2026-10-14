import { Invoice, InvoiceCounter, CreditNote } from "./invoice.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { Order } from "../orders/order.model.js";
import { AppError } from "../../utils/AppError.js";
import { round2, splitInclusive, FEE_TAX_RATE } from "../pricing/engine.js";
import * as constants from "../../config/constants.js";
import { withTransaction, withSession } from "../../utils/transaction.js";
import { normalizeIndianState } from "../location/pincode.js";

/** GST on delivery / platform / partner charges (services), included in the fee. */
export { FEE_TAX_RATE };
export const FEE_SAC = { delivery: "996812", platform: "998599", partner: "996812" };
/** Fees the platform invoices itself (split invoicing): platform fee + platform courier / partner fee. */
export const PLATFORM_FEE_KEYS = ["partner", "platform"];
/** Fees on the seller's own invoice (split invoicing): the seller's delivery charge. */
export const SELLER_FEE_KEYS = ["delivery"];
const ALL_FEE_KEYS = ["delivery", "partner", "platform"];
export const INVOICEABLE = [
  "confirmed",
  "processing",
  "ready_to_ship",
  "shipped",
  "out_for_delivery",
  "delivered",
  "return_requested",
  "return_approved",
  "returned",
  "rto_in_transit",
  "returned_to_origin",
  "refunded",
];

const BUSINESS_TZ = constants.BUSINESS_TZ || "Asia/Kolkata";

/** Calendar parts of `date` in the business timezone (Asia/Kolkata), independent of server TZ. */
export function businessDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(date));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** Indian financial year (Apr–Mar) of `date`, computed in IST. */
export function financialYear(date = new Date()) {
  const { year, month } = businessDateParts(date);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

function normState(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** GST state code (first two digits of a GSTIN) -> ISO 3166-2:IN code used by normalizeIndianState. */
const GST_STATE_CODES = {
  "01": "JK", "02": "HP", "03": "PB", "04": "CH", "05": "UK", "06": "HR", "07": "DL", "08": "RJ", "09": "UP",
  10: "BR", 11: "SK", 12: "AR", 13: "NL", 14: "MN", 15: "MZ", 16: "TR", 17: "ML", 18: "AS", 19: "WB",
  20: "JH", 21: "OD", 22: "CT", 23: "MP", 24: "GJ", 25: "DH", 26: "DH", 27: "MH", 28: "AP", 29: "KA",
  30: "GA", 31: "LD", 32: "KL", 33: "TN", 34: "PY", 35: "AN", 36: "TG", 37: "AP", 38: "LA",
};

function gstinStateCode(gstin) {
  const prefix = String(gstin || "").trim().slice(0, 2);
  return /^\d{2}$/.test(prefix) ? GST_STATE_CODES[prefix] || null : null;
}

/** ISO state code of a party: its state (any spelling / code), else its GSTIN prefix, else null. */
export function partyStateCode(state, gstin = "") {
  return normalizeIndianState(state).stateCode || gstinStateCode(gstin);
}

/**
 * Intra-state (CGST + SGST) only when both states are known and equal. States are compared as
 * normalised codes ("DL" = "Delhi" = "New Delhi"); a party whose state is not recognised falls
 * back to the state code in its GSTIN. When either state is still unknown we charge IGST (the
 * safe default) and flag the document for review.
 */
export function supplyTypeFor(sellerState, buyerState, { sellerGstin = "", buyerGstin = "" } = {}) {
  const a = partyStateCode(sellerState, sellerGstin);
  const b = partyStateCode(buyerState, buyerGstin);
  if (a && b) return a === b ? "intra" : "inter";
  const x = normState(sellerState);
  const y = normState(buyerState);
  if (!x || !y) return "inter";
  return x === y ? "intra" : "inter";
}

export function splitTax(tax, supplyType) {
  if (supplyType === "inter") return { cgst: 0, sgst: 0, igst: round2(tax) };
  const cgst = round2(tax / 2);
  return { cgst, sgst: round2(tax - cgst), igst: 0 };
}

export function formatAddress(a = {}) {
  return [a.addressLine1, a.addressLine2, a.city, a.state, a.postalCode].filter(Boolean).join(", ");
}

/** Order fees as [key, description, gross] (gross = GST-inclusive amount, may be 0). */
export function orderFees(order) {
  return [
    ["delivery", "Delivery charges", round2(order.deliveryFee || 0)],
    ["partner", order.deliveryPartner?.name ? `Delivery partner (${order.deliveryPartner.name})` : "Delivery partner fee", round2(order.partnerFee || 0)],
    ["platform", "Platform fee", round2(order.platformFee || 0)],
  ];
}

/** One GST-inclusive fee line (18%, SAC per fee). */
export function feeLine(key, description, gross, supplyType) {
  const { taxableValue, tax } = splitInclusive(gross, FEE_TAX_RATE);
  return {
    kind: "fee",
    feeKey: key,
    description,
    sku: "",
    hsn: FEE_SAC[key],
    qty: 1,
    unitPrice: gross,
    grossAmount: gross,
    discount: 0,
    taxableValue,
    taxRate: FEE_TAX_RATE,
    ...splitTax(tax, supplyType),
    tax,
    total: gross,
  };
}

/**
 * Spread a refunded fee amount over the order's fees in proportion (the last fee with an amount
 * takes the rounding remainder). Returns [{ key, description, gross }] for every fee > 0.
 */
export function allocateFeeRefund(order, feesAmount = 0) {
  const fees = orderFees(order).filter(([, , amount]) => amount > 0);
  const feeSum = round2(fees.reduce((s, [, , a]) => s + a, 0));
  const target = round2(Math.min(Number(feesAmount) || 0, feeSum));
  const out = [];
  if (!(target > 0) || !(feeSum > 0)) return out;
  let left = target;
  fees.forEach(([key, description, amount], idx) => {
    const gross = idx === fees.length - 1 ? round2(left) : round2((amount * target) / feeSum);
    left = round2(left - gross);
    if (gross > 0) out.push({ key, description, gross });
  });
  return out;
}

/**
 * Invoice lines of an order. `feeKeys` limits which fees are included: all three on combined
 * (pre-phase-4) invoices, only the seller's delivery charge on split seller invoices.
 */
export function buildInvoiceLines(order, supplyType, { feeKeys = ALL_FEE_KEYS } = {}) {
  const lines = (order.items || []).map((item) => {
    const grossAmount = round2(item.lineSubtotal ?? item.unitPrice * item.qty);
    const discount = round2(item.couponShare || 0);
    const net = round2(grossAmount - discount);
    const { taxableValue, tax } =
      item.taxableValue != null
        ? { taxableValue: round2(item.taxableValue), tax: round2(item.tax) }
        : splitInclusive(net, item.taxRate);
    return {
      kind: "item",
      description: item.name,
      sku: item.sku,
      hsn: item.hsn || "",
      qty: item.qty,
      unitPrice: item.unitPrice,
      grossAmount,
      discount,
      taxableValue,
      taxRate: item.taxRate || 0,
      ...splitTax(tax, supplyType),
      tax,
      total: net,
    };
  });
  if (order.couponDiscount && !(order.items || []).some((i) => i.couponShare)) {
    // Orders placed before per-line coupon shares existed: put the coupon on the last line.
    const lastItem = lines[lines.length - 1];
    if (lastItem) {
      lastItem.discount = round2(order.couponDiscount);
      lastItem.total = round2(lastItem.grossAmount - lastItem.discount);
      const { taxableValue, tax } = splitInclusive(lastItem.total, lastItem.taxRate);
      Object.assign(lastItem, { taxableValue, tax, ...splitTax(tax, supplyType) });
    }
  }
  for (const [key, description, gross] of orderFees(order)) {
    if (gross <= 0 || !feeKeys.includes(key)) continue;
    const { feeKey, ...line } = feeLine(key, description, gross, supplyType);
    lines.push(line);
  }
  return lines;
}

export function sumTotals(lines) {
  const sum = (key) => round2(lines.reduce((s, l) => s + (Number(l[key]) || 0), 0));
  return {
    grossAmount: sum("grossAmount"),
    discount: sum("discount"),
    taxableValue: sum("taxableValue"),
    cgst: sum("cgst"),
    sgst: sum("sgst"),
    igst: sum("igst"),
    tax: sum("tax"),
    grandTotal: sum("total"),
  };
}


/** GST rule 46: invoice / credit note serial numbers are at most 16 characters. */
export const MAX_DOC_NUMBER_LENGTH = 16;

/** Short store code (<= 4 uppercase letters/digits) derived from the store slug or name. */
export function documentCode(tenant) {
  const raw = String(tenant?.slug || tenant?.name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.slice(0, 4) || "MSP";
}

/**
 * Document number, always <= 16 chars:
 *   invoice      CODE/2627/000123   (code <= 4, FY "2026-27" -> "2627", 6-digit sequence)
 *   credit note  CODE/2627/C00123   (C + 5-digit sequence)
 * Very large sequences first shorten the code, then drop the separators. Numbers issued before
 * this format (INV/<SLUG>/<FY>/<SEQ>) are kept as they are.
 */
export function formatDocNumber(code, fy, seq, kind = "invoice") {
  const fy4 = String(fy).replace(/^\d{2}(\d{2})-(\d{2})$/, "$1$2");
  const tail = kind === "credit_note" ? `C${String(seq).padStart(5, "0")}` : String(seq).padStart(6, "0");
  let c = String(code || "MSP").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) || "M";
  let out = `${c}/${fy4}/${tail}`;
  while (out.length > MAX_DOC_NUMBER_LENGTH && c.length > 1) {
    c = c.slice(0, -1);
    out = `${c}/${fy4}/${tail}`;
  }
  if (out.length > MAX_DOC_NUMBER_LENGTH) out = `${c}${fy4}${tail}`;
  return out;
}

/**
 * Counter bump inside the caller's transaction: an aborted invoice never burns a number.
 * Returns { seq, code }: the store code is fixed on the counter row the first time the series
 * is used in a financial year, so a later slug change cannot change the prefix mid-year.
 */
async function nextSequence(tenantId, key, session, tenant = null) {
  const counter = await InvoiceCounter.findOneAndUpdate(
    { tenantId, financialYear: key },
    { $inc: { seq: 1 } },
    withSession(session, { new: true, upsert: true, setDefaultsOnInsert: true })
  );
  let code = counter.code;
  if (!code) {
    code = documentCode(tenant);
    await InvoiceCounter.updateOne({ _id: counter._id, code: { $in: ["", null] } }, { $set: { code } }, withSession(session));
  }
  return { seq: counter.seq, code };
}

async function parties(order, session) {
  const tenantId = order.tenantId?._id || order.tenantId;
  const tenant = await Tenant.findById(tenantId, null, withSession(session)).lean();
  const seller = order.sellerSnapshot?.name
    ? order.sellerSnapshot
    : {
        name: tenant?.name || "",
        legalName: tenant?.businessProfile?.legalName || tenant?.name || "",
        gstin: tenant?.businessProfile?.gstin || "",
        state: tenant?.pickupAddress?.state || "",
        address: formatAddress(tenant?.pickupAddress),
        email: tenant?.businessProfile?.email || "",
        phone: tenant?.businessProfile?.phone || "",
      };
  const ship = order.addressSnapshot || {};
  const buyerSnap = order.buyerSnapshot || {};
  const sellerPlain = typeof seller.toObject === "function" ? seller.toObject() : seller;
  return {
    tenantId,
    tenant,
    seller: sellerPlain,
    ship,
    buyer: {
      name: buyerSnap.name || ship.contactName || ship.name || "",
      company: buyerSnap.company || "",
      gstin: buyerSnap.gstin || "",
      state: ship.state || "",
      address: formatAddress(ship),
      email: buyerSnap.email || "",
      phone: buyerSnap.phone || ship.phone || "",
    },
    shipTo: {
      name: ship.contactName || ship.name || buyerSnap.name || "",
      state: ship.state || "",
      address: formatAddress(ship),
      phone: ship.phone || "",
    },
  };
}

/**
 * Issue the order's GST invoice. Idempotent per order. The sequence number and the invoice are
 * written in one transaction (the caller's, or a new one), with a unique
 * {tenantId, financialYear, sequence} index, so numbers are gap-free and never reused.
 */
export async function generateInvoice(order, { session = null } = {}) {
  const run = async (s) => {
    const existing = await Invoice.findOne({ orderId: order._id }, null, withSession(s));
    if (existing) return existing;
    const p = await parties(order, s);
    const gstins = { sellerGstin: p.seller.gstin, buyerGstin: p.buyer.gstin };
    const supplyType = supplyTypeFor(p.seller.state, p.ship.state, gstins);
    // Split invoicing (phase 4): the seller invoices goods + its own delivery charge; the
    // platform fee and platform courier / partner fee go on the platform's own invoice.
    const lines = buildInvoiceLines(order, supplyType, { feeKeys: SELLER_FEE_KEYS });
    const totals = sumTotals(lines);
    const issuedAt = new Date();
    const fy = financialYear(issuedAt);
    const { seq, code } = await nextSequence(p.tenantId, fy, s, p.tenant);
    const invoiceNumber = formatDocNumber(code, fy, seq, "invoice");
    const [invoice] = await Invoice.create(
      [
        {
          invoiceNumber,
          tenantId: p.tenantId,
          orderId: order._id,
          orderNumber: order.orderNumber,
          buyerId: order.buyerId?._id || order.buyerId,
          financialYear: fy,
          sequence: seq,
          issuedAt,
          seller: p.seller,
          buyer: p.buyer,
          shipTo: p.shipTo,
          placeOfSupply: p.ship.state || p.seller.state || "",
          supplyType,
          placeOfSupplyUnknown: !partyStateCode(p.seller.state, gstins.sellerGstin) || !partyStateCode(p.ship.state, gstins.buyerGstin),
          paymentMethod: order.paymentMethod,
          poNumber: order.poNumber || "",
          couponCode: order.couponCode || "",
          feeLayout: "split",
          lines,
          totals,
        },
      ],
      withSession(s)
    );
    await Order.updateOne(
      { _id: order._id },
      { $set: { invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber } },
      withSession(s)
    );
    order.invoiceId = invoice._id;
    order.invoiceNumber = invoice.invoiceNumber;
    const platform = await import("./platform.js");
    await platform.issuePlatformInvoice(order, { session: s, sellerInvoice: invoice });
    return invoice;
  };
  if (session) return run(session);
  try {
    return await withTransaction(run);
  } catch (err) {
    if (err?.code === 11000) {
      const again = await Invoice.findOne({ orderId: order._id });
      if (again) return again;
    }
    throw err;
  }
}

/**
 * Void an invoice. Not used by the order flow any more: a cancelled order whose invoice was issued
 * gets a full credit note instead (an issued invoice may already be reported). Kept for callers.
 */
export async function cancelInvoice(orderId, { session = null } = {}) {
  await Invoice.updateOne({ orderId, status: "issued" }, { $set: { status: "cancelled" } }, withSession(session));
}

/**
 * Credit note lines for part of an order: `items` = [{ itemId, qty, amount, taxableValue, tax }]
 * (amounts GST-inclusive, after coupon) plus `feesAmount` spread over the order's fees in
 * proportion (the last fee takes the rounding remainder).
 */
export function creditLinesFor(order, supplyType, { items = [], feesAmount = 0, feeKeys = ALL_FEE_KEYS } = {}) {
  const lines = [];
  for (const row of items) {
    const item = (order.items || []).find((i) => String(i._id) === String(row.itemId));
    if (!item || !(row.qty > 0)) continue;
    const amount = round2(row.amount || 0);
    const grossAmount = round2((item.unitPrice || 0) * row.qty);
    const taxableValue = round2(row.taxableValue ?? splitInclusive(amount, item.taxRate || 0).taxableValue);
    const tax = round2(amount - taxableValue);
    lines.push({
      kind: "item",
      description: item.name,
      sku: item.sku,
      hsn: item.hsn || "",
      qty: row.qty,
      unitPrice: item.unitPrice,
      grossAmount,
      discount: round2(Math.max(0, grossAmount - amount)),
      taxableValue,
      taxRate: item.taxRate || 0,
      ...splitTax(tax, supplyType),
      tax,
      total: amount,
    });
  }
  for (const { key, description, gross } of allocateFeeRefund(order, feesAmount)) {
    if (!feeKeys.includes(key)) continue;
    const { feeKey, ...line } = feeLine(key, description, gross, supplyType);
    lines.push(line);
  }
  return lines;
}

/**
 * Credit note against the order's invoice. One per refund key; numbered in its own series
 * (`CODE/2627/C00001`) inside the caller's transaction. Without `part` it reverses the whole
 * invoice; with `part` = { items, feesAmount, returnId } it covers only those lines (returns,
 * or what is left after earlier partial returns).
 */
export async function issueCreditNote(order, { refundKey, reason = "", session = null, part = null } = {}) {
  const run = async (s) => {
    const existing = await CreditNote.findOne({ orderId: order._id, refundKey }, null, withSession(s));
    if (existing) return existing;
    const invoice =
      (await Invoice.findOne({ orderId: order._id }, null, withSession(s))) || (await generateInvoice(order, { session: s }));
    const split = invoice.feeLayout === "split";
    let platformNote = null;
    if (split) {
      // The platform's share of the refunded fees goes on a credit note in the platform series.
      const platform = await import("./platform.js");
      platformNote = await platform.issuePlatformCreditNote(order, { refundKey, reason, part, session: s });
    }
    const lines = part
      ? creditLinesFor(order, invoice.supplyType, split ? { ...part, feeKeys: SELLER_FEE_KEYS } : part)
      : invoice.lines;
    // Only platform fees refunded (no goods / own delivery): no seller document to issue.
    if (split && !lines.length && platformNote) return platformNote;
    const p = await parties(order, s);
    const issuedAt = new Date();
    const fy = financialYear(issuedAt);
    const { seq, code } = await nextSequence(p.tenantId, `${fy}:CN`, s, p.tenant);
    const totals = part ? sumTotals(lines) : invoice.totals;
    const [note] = await CreditNote.create(
      [
        {
          creditNoteNumber: formatDocNumber(code, fy, seq, "credit_note"),
          scope: part ? "partial" : "full",
          returnId: part?.returnId || null,
          tenantId: p.tenantId,
          orderId: order._id,
          invoiceId: invoice._id,
          invoiceNumber: invoice.invoiceNumber,
          orderNumber: order.orderNumber,
          buyerId: order.buyerId?._id || order.buyerId,
          reason,
          refundKey,
          financialYear: fy,
          sequence: seq,
          issuedAt,
          seller: invoice.seller,
          buyer: invoice.buyer,
          placeOfSupply: invoice.placeOfSupply,
          supplyType: invoice.supplyType,
          lines,
          totals,
        },
      ],
      withSession(s)
    );
    await Order.updateOne({ _id: order._id }, { $addToSet: { creditNoteIds: note._id } }, withSession(s));
    return note;
  };
  return session ? run(session) : withTransaction(run);
}

export async function creditNotesForOrder(order) {
  return CreditNote.find({ orderId: order._id }).sort({ issuedAt: 1 });
}

/** Load (or lazily issue) the invoice for an order the caller is already allowed to see. */
export async function getInvoiceForOrder(order) {
  const invoice = await Invoice.findOne({ orderId: order._id });
  if (invoice) return invoice;
  if (!INVOICEABLE.includes(order.status)) {
    throw new AppError(404, "The invoice is issued once the seller confirms the order", "NO_INVOICE");
  }
  return generateInvoice(order);
}

/** Kept for callers that issued the invoice themselves. */
export async function attachInvoice(order, invoice, { session = null } = {}) {
  await Order.updateOne(
    { _id: order._id },
    { $set: { invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber } },
    withSession(session)
  );
  order.invoiceId = invoice._id;
  order.invoiceNumber = invoice.invoiceNumber;
}
