import { PlatformInvoiceCounter } from "./invoice.model.js";
import { getCachedSetting } from "../settings/service.js";
import { SETTINGS_REGISTRY } from "../settings/registry.js";
import { supplyTypeFor, partyStateCode, financialYear, formatDocNumber } from "../invoices/service.js";
import { normalizeIndianState } from "../location/pincode.js";
import { withSession } from "../../utils/transaction.js";

/** GST on seller subscriptions (added on top of the GST-exclusive plan price). */
export const SUBSCRIPTION_GST_RATE = 18;

export const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

async function setting(key) {
  const fallback = SETTINGS_REGISTRY[key]?.default ?? null;
  try {
    const value = await getCachedSetting("platform", null, key, fallback);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/** Platform supplier identity + billing knobs (settings, cached 60s). */
export async function billingSettings() {
  const [legalName, gstin, address, invoicePrefix, sac, state, graceDays, platformName] = await Promise.all([
    setting("platform.legalName"),
    setting("platform.gstin"),
    setting("platform.address"),
    setting("platform.invoicePrefix"),
    setting("platform.subscriptionSac"),
    setting("platform.state"),
    setting("billing.graceDays"),
    setting("platform.name"),
  ]);
  return {
    supplier: {
      name: platformName || "",
      legalName: legalName || platformName || "",
      gstin: String(gstin || "").toUpperCase(),
      address: address || "",
      state: state ? normalizeIndianState(state).state || String(state) : "",
    },
    invoicePrefix: String(invoicePrefix || "MSPB").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) || "MSPB",
    sac: String(sac || "998314"),
    graceDays: Number.isFinite(Number(graceDays)) ? Number(graceDays) : 7,
  };
}

function formatAddress(a = {}) {
  return [a.addressLine1, a.addressLine2, a.city, a.state, a.postalCode].filter(Boolean).join(", ");
}

/** The seller (recipient of the platform's invoice). */
export function recipientFor(tenant) {
  const t = tenant || {};
  const gstin = String(t.businessProfile?.gstin || t.kyc?.gstin || "").toUpperCase();
  const reg = t.kyc?.registeredAddress || {};
  const address = formatAddress(reg.addressLine1 ? reg : t.pickupAddress || {});
  const state = reg.addressLine1 && reg.state ? reg.state : t.pickupAddress?.state || reg.state || "";
  return {
    name: t.name || "",
    legalName: t.kyc?.legalName || t.businessProfile?.legalName || t.name || "",
    gstin,
    address,
    state,
    email: t.businessProfile?.email || "",
  };
}

/**
 * Totals for GST-exclusive `lines`. Intra-state (CGST + SGST) only when the platform's and the
 * seller's states are both known and equal (state name/code, else GSTIN prefix), else IGST.
 * `grossTotal` (autopay charges): the amount actually collected incl. GST; the tax is then
 * total - subtotal so the invoice adds up to what was charged.
 */
export function computeTotals(lines, { supplier = {}, recipient = {}, grossTotal = null } = {}) {
  const subtotal = round2(Math.max(0, lines.reduce((s, l) => s + (Number(l.amount) || 0), 0)));
  const taxAmount = grossTotal != null ? round2(Math.max(0, grossTotal - subtotal)) : round2((subtotal * SUBSCRIPTION_GST_RATE) / 100);
  const supplyType = supplyTypeFor(supplier.state, recipient.state, { sellerGstin: supplier.gstin, buyerGstin: recipient.gstin });
  let tax;
  if (supplyType === "intra") {
    const cgst = round2(taxAmount / 2);
    tax = { cgst, sgst: round2(taxAmount - cgst), igst: 0 };
  } else {
    tax = { cgst: 0, sgst: 0, igst: taxAmount };
  }
  const placeCode = partyStateCode(recipient.state, recipient.gstin);
  return {
    subtotal,
    taxRate: SUBSCRIPTION_GST_RATE,
    tax,
    total: round2(subtotal + taxAmount),
    supplyType,
    placeOfSupply: recipient.state || placeCode || "",
  };
}

/**
 * Next platform invoice number inside the caller's transaction (an aborted invoice never burns a
 * number). One series per prefix + financial year: PREF/2627/000001 (<= 16 chars).
 */
export async function nextInvoiceNumber(prefix, session = null, at = new Date()) {
  const fy = financialYear(at);
  const counter = await PlatformInvoiceCounter.findOneAndUpdate(
    { _id: `${prefix}:${fy}` },
    { $inc: { seq: 1 }, $setOnInsert: { code: prefix } },
    withSession(session, { new: true, upsert: true })
  );
  return { number: formatDocNumber(counter.code || prefix, fy, counter.seq, "invoice"), financialYear: fy, sequence: counter.seq };
}
