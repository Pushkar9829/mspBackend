import { Invoice, InvoiceCounter } from "./invoice.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { Order } from "../orders/order.model.js";
import { AppError } from "../../utils/AppError.js";
import { round2, splitInclusive } from "../pricing/engine.js";

/** GST on delivery / platform / partner charges (services), included in the fee. */
export const FEE_TAX_RATE = 18;
const FEE_SAC = { delivery: "996812", platform: "998599", partner: "996812" };
const INVOICEABLE = ["confirmed", "processing", "ready_to_ship", "shipped", "out_for_delivery", "delivered", "return_requested", "refunded"];

export function financialYear(date = new Date()) {
  const d = new Date(date);
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

function normState(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Intra-state (CGST + SGST) when seller and place-of-supply states match or either is unknown. */
export function supplyTypeFor(sellerState, buyerState) {
  const a = normState(sellerState);
  const b = normState(buyerState);
  if (!a || !b) return "intra";
  return a === b ? "intra" : "inter";
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

async function nextSequence(tenantId, fy) {
  const counter = await InvoiceCounter.findOneAndUpdate(
    { tenantId, financialYear: fy },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return counter.seq;
}

/** Idempotent: returns the existing invoice for the order if one was already issued. */
export async function generateInvoice(order) {
  const existing = await Invoice.findOne({ orderId: order._id });
  if (existing) return existing;

  const tenantId = order.tenantId?._id || order.tenantId;
  const tenant = await Tenant.findById(tenantId).lean();
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
  const supplyType = supplyTypeFor(seller.state, ship.state);
  const lines = buildInvoiceLines(order, supplyType);
  const totals = sumTotals(lines);

  const issuedAt = new Date();
  const fy = financialYear(issuedAt);
  const seq = await nextSequence(tenantId, fy);
  const slug = String(tenant?.slug || "MSP").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16) || "MSP";
  const invoiceNumber = `INV/${slug}/${fy}/${String(seq).padStart(6, "0")}`;

  try {
    const invoice = await Invoice.create({
      invoiceNumber,
      tenantId,
      orderId: order._id,
      orderNumber: order.orderNumber,
      buyerId: order.buyerId?._id || order.buyerId,
      financialYear: fy,
      sequence: seq,
      issuedAt,
      seller,
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
      placeOfSupply: ship.state || seller.state || "",
      supplyType,
      paymentMethod: order.paymentMethod,
      poNumber: order.poNumber || "",
      couponCode: order.couponCode || "",
      lines,
      totals,
    });
    return invoice;
  } catch (err) {
    if (err?.code === 11000) {
      const again = await Invoice.findOne({ orderId: order._id });
      if (again) return again;
    }
    throw err;
  }
}

export async function cancelInvoice(orderId) {
  await Invoice.updateOne({ orderId, status: "issued" }, { $set: { status: "cancelled" } });
}

/** Load (or lazily issue) the invoice for an order the caller is already allowed to see. */
export async function getInvoiceForOrder(order) {
  let invoice = await Invoice.findOne({ orderId: order._id });
  if (!invoice) {
    if (!INVOICEABLE.includes(order.status)) {
      throw new AppError(404, "The invoice is issued once the seller confirms the order", "NO_INVOICE");
    }
    invoice = await generateInvoice(order);
    await attachInvoice(order, invoice);
  }
  return invoice;
}

export async function attachInvoice(order, invoice) {
  await Order.updateOne(
    { _id: order._id },
    { $set: { invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber } }
  );
  order.invoiceId = invoice._id;
  order.invoiceNumber = invoice.invoiceNumber;
}
