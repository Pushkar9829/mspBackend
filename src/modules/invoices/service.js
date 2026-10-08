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
const FEE_SAC = { delivery: "996812", platform: "998599", partner: "996812" };
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

function splitTax(tax, supplyType) {
  if (supplyType === "inter") return { cgst: 0, sgst: 0, igst: round2(tax) };
  const cgst = round2(tax / 2);
  return { cgst, sgst: round2(tax - cgst), igst: 0 };
}

function formatAddress(a = {}) {
  return [a.addressLine1, a.addressLine2, a.city, a.state, a.postalCode].filter(Boolean).join(", ");
}

export function buildInvoiceLines(order, supplyType) {
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
  const fees = [
    ["delivery", "Delivery charges", order.deliveryFee],
    ["partner", order.deliveryPartner?.name ? `Delivery partner (${order.deliveryPartner.name})` : "Delivery partner fee", order.partnerFee],
    ["platform", "Platform fee", order.platformFee],
  ];
  for (const [key, description, amount] of fees) {
    const gross = round2(amount || 0);
    if (gross <= 0) continue;
    const { taxableValue, tax } = splitInclusive(gross, FEE_TAX_RATE);
    lines.push({
      kind: "fee",
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
    });
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


/** Counter bump inside the caller's transaction: an aborted invoice never burns a number. */
async function nextSequence(tenantId, key, session) {
  const counter = await InvoiceCounter.findOneAndUpdate(
    { tenantId, financialYear: key },
    { $inc: { seq: 1 } },
    withSession(session, { new: true, upsert: true, setDefaultsOnInsert: true })
  );
  return counter.seq;
}

function tenantSlug(tenant) {
  return String(tenant?.slug || "MSP").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16) || "MSP";
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
    const lines = buildInvoiceLines(order, supplyType);
    const totals = sumTotals(lines);
    const issuedAt = new Date();
    const fy = financialYear(issuedAt);
    const seq = await nextSequence(p.tenantId, fy, s);
    const invoiceNumber = `INV/${tenantSlug(p.tenant)}/${fy}/${String(seq).padStart(6, "0")}`;
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

export async function cancelInvoice(orderId, { session = null } = {}) {
  await Invoice.updateOne({ orderId, status: "issued" }, { $set: { status: "cancelled" } }, withSession(session));
}

/**
 * Credit note for a refund (full order). One per refund key; numbered in its own series
 * (`CN/<STORE>/<FY>/000001`) inside the caller's transaction.
 */
export async function issueCreditNote(order, { refundKey, reason = "", session = null } = {}) {
  const run = async (s) => {
    const existing = await CreditNote.findOne({ orderId: order._id, refundKey }, null, withSession(s));
    if (existing) return existing;
    const invoice =
      (await Invoice.findOne({ orderId: order._id }, null, withSession(s))) || (await generateInvoice(order, { session: s }));
    const p = await parties(order, s);
    const issuedAt = new Date();
    const fy = financialYear(issuedAt);
    const seq = await nextSequence(p.tenantId, `${fy}:CN`, s);
    const [note] = await CreditNote.create(
      [
        {
          creditNoteNumber: `CN/${tenantSlug(p.tenant)}/${fy}/${String(seq).padStart(6, "0")}`,
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
          lines: invoice.lines,
          totals: invoice.totals,
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
