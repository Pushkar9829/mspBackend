/**
 * Platform order invoices (split invoicing, phase 4): the platform invoices the buyer for the
 * platform fee (SAC 998599) and the platform courier / delivery partner fee (SAC 996812). GST is
 * the fee GST already inside those fees (order.feeTax share, 18% inclusive); CGST+SGST when the
 * platform's state equals the buyer's (ship-to) state, else IGST. Own series per prefix
 * (platform.orderInvoicePrefix) + FY, separate from seller invoices and subscription invoices.
 */
import { PlatformOrderInvoice, PlatformCreditNote } from "./platformInvoice.model.js";
import { PlatformInvoiceCounter } from "../billing/invoice.model.js";
import { Order } from "../orders/order.model.js";
import { billingSettings } from "../billing/invoicing.js";
import { getCachedSetting } from "../settings/service.js";
import { withSession, withTransaction } from "../../utils/transaction.js";
import {
  PLATFORM_FEE_KEYS,
  orderFees,
  feeLine,
  allocateFeeRefund,
  sumTotals,
  supplyTypeFor,
  partyStateCode,
  financialYear,
  formatDocNumber,
  formatAddress,
} from "./service.js";

export async function orderInvoicePrefix() {
  let raw = "MSPF";
  try {
    raw = (await getCachedSetting("platform", null, "platform.orderInvoicePrefix", "MSPF")) || "MSPF";
  } catch {
    /* default */
  }
  return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) || "MSPF";
}

/** Next number in the platform order-invoice series (inside the caller's transaction). */
async function nextNumber(prefix, kind, session, at = new Date()) {
  const fy = financialYear(at);
  const id = `${kind === "credit_note" ? "ORDCN" : "ORD"}:${prefix}:${fy}`;
  const counter = await PlatformInvoiceCounter.findOneAndUpdate(
    { _id: id },
    { $inc: { seq: 1 }, $setOnInsert: { code: prefix } },
    withSession(session, { new: true, upsert: true })
  );
  return { number: formatDocNumber(counter.code || prefix, fy, counter.seq, kind), financialYear: fy, sequence: counter.seq };
}

/** Platform fee lines of an order (GST-inclusive amounts). */
export function platformFeeLines(order, supplyType) {
  return orderFees(order)
    .filter(([key, , gross]) => PLATFORM_FEE_KEYS.includes(key) && gross > 0)
    .map(([key, description, gross]) => feeLine(key, description, gross, supplyType));
}

export function hasPlatformFees(order) {
  return platformFeeLines(order, "inter").length > 0;
}

async function partiesFor(order) {
  const { supplier } = await billingSettings();
  const ship = order.addressSnapshot || {};
  const buyerSnap = order.buyerSnapshot || {};
  const buyer = {
    name: buyerSnap.name || ship.contactName || ship.name || "",
    company: buyerSnap.company || "",
    gstin: buyerSnap.gstin || "",
    state: ship.state || "",
    address: formatAddress(ship),
    email: buyerSnap.email || "",
    phone: buyerSnap.phone || ship.phone || "",
  };
  const supplyType = supplyTypeFor(supplier.state, buyer.state, { sellerGstin: supplier.gstin, buyerGstin: buyer.gstin });
  return {
    supplier: { name: supplier.name, legalName: supplier.legalName, gstin: supplier.gstin, state: supplier.state, address: supplier.address },
    buyer,
    supplyType,
    placeOfSupply: buyer.state || "",
    placeOfSupplyUnknown: !partyStateCode(supplier.state, supplier.gstin) || !partyStateCode(buyer.state, buyer.gstin),
  };
}

/**
 * Issue the platform invoice of an order (idempotent per order). No-op (null) when the order has
 * no platform fee / platform courier fee.
 */
export async function issuePlatformInvoice(order, { session = null, sellerInvoice = null } = {}) {
  const run = async (s) => {
    const existing = await PlatformOrderInvoice.findOne({ orderId: order._id }, null, withSession(s));
    if (existing) return existing;
    if (!hasPlatformFees(order)) return null;
    const p = await partiesFor(order);
    const lines = platformFeeLines(order, p.supplyType);
    const issuedAt = new Date();
    const prefix = await orderInvoicePrefix();
    const num = await nextNumber(prefix, "invoice", s, issuedAt);
    const [doc] = await PlatformOrderInvoice.create(
      [
        {
          invoiceNumber: num.number,
          prefix,
          financialYear: num.financialYear,
          sequence: num.sequence,
          issuedAt,
          tenantId: order.tenantId?._id || order.tenantId,
          orderId: order._id,
          orderNumber: order.orderNumber,
          buyerId: order.buyerId?._id || order.buyerId,
          sellerInvoiceId: sellerInvoice?._id || order.invoiceId || null,
          sellerInvoiceNumber: sellerInvoice?.invoiceNumber || order.invoiceNumber || "",
          paymentMethod: order.paymentMethod,
          seller: p.supplier,
          buyer: p.buyer,
          placeOfSupply: p.placeOfSupply,
          supplyType: p.supplyType,
          placeOfSupplyUnknown: p.placeOfSupplyUnknown,
          lines,
          totals: sumTotals(lines),
        },
      ],
      withSession(s)
    );
    await Order.updateOne({ _id: order._id }, { $set: { platformInvoiceId: doc._id, platformInvoiceNumber: doc.invoiceNumber } }, withSession(s));
    order.platformInvoiceId = doc._id;
    order.platformInvoiceNumber = doc.invoiceNumber;
    return doc;
  };
  return session ? run(session) : withTransaction(run);
}

/**
 * Credit note on the platform series for the platform's share of a refund. Full (`part` null)
 * reverses the whole platform invoice; `part.feesAmount` is spread over all the order's fees the
 * same way the seller credit note does it, and only the platform / partner shares land here.
 * Returns null when nothing of the platform's was refunded (or the order has no platform invoice).
 */
export async function issuePlatformCreditNote(order, { refundKey, reason = "", part = null, session = null } = {}) {
  const run = async (s) => {
    const existing = await PlatformCreditNote.findOne({ orderId: order._id, refundKey }, null, withSession(s));
    if (existing) return existing;
    const invoice = await PlatformOrderInvoice.findOne({ orderId: order._id }, null, withSession(s));
    if (!invoice) return null;
    const lines = part
      ? allocateFeeRefund(order, part.feesAmount || 0)
          .filter((f) => PLATFORM_FEE_KEYS.includes(f.key))
          .map((f) => feeLine(f.key, f.description, f.gross, invoice.supplyType))
      : (invoice.lines || []).map((l) => (typeof l.toObject === "function" ? l.toObject() : l));
    if (!lines.length) return null;
    const issuedAt = new Date();
    const num = await nextNumber(invoice.prefix, "credit_note", s, issuedAt);
    const [note] = await PlatformCreditNote.create(
      [
        {
          creditNoteNumber: num.number,
          prefix: invoice.prefix,
          financialYear: num.financialYear,
          sequence: num.sequence,
          issuedAt,
          scope: part ? "partial" : "full",
          returnId: part?.returnId || null,
          tenantId: invoice.tenantId,
          orderId: order._id,
          orderNumber: invoice.orderNumber,
          buyerId: invoice.buyerId,
          invoiceId: invoice._id,
          invoiceNumber: invoice.invoiceNumber,
          reason,
          refundKey,
          seller: invoice.seller,
          buyer: invoice.buyer,
          placeOfSupply: invoice.placeOfSupply,
          supplyType: invoice.supplyType,
          placeOfSupplyUnknown: invoice.placeOfSupplyUnknown,
          lines,
          totals: part ? sumTotals(lines) : invoice.totals,
        },
      ],
      withSession(s)
    );
    return note;
  };
  return session ? run(session) : withTransaction(run);
}

export async function platformInvoiceForOrder(order) {
  return PlatformOrderInvoice.findOne({ orderId: order._id });
}

export async function platformCreditNotesForOrder(order) {
  return PlatformCreditNote.find({ orderId: order._id }).sort({ issuedAt: 1 });
}
