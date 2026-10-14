/**
 * Marketplace withholding taxes on seller supplies (pure maths + settings reader).
 *  - GST TCS (CGST Act s.52): tax.tcsRate % (default 0.5) of the seller's net taxable value;
 *    CGST + SGST halves for intra-state supplies, IGST for inter-state (same rule as invoices).
 *  - Income-tax TDS (s.194-O): tax.tdsRate % (default 0.1) of gross sales excluding GST.
 * Base = goods taxable value (after coupon) + taxable value of the seller's own delivery fee.
 * Platform fee and platform courier / partner fee are the platform's own supply: never in the base.
 * All amounts returned in paise; each component rounded to the paise, never negative.
 */
import { getCachedSetting } from "../settings/service.js";
import { SETTINGS_REGISTRY } from "../settings/registry.js";
import { supplyTypeFor } from "../invoices/service.js";
import { splitInclusive, FEE_TAX_RATE } from "../pricing/engine.js";

export const DEFAULT_TAX_SETTINGS = Object.freeze({ tcsRate: 0.5, tdsRate: 0.1, tcsEnabled: true, tdsEnabled: true });

async function setting(key) {
  const fallback = SETTINGS_REGISTRY[key]?.default ?? DEFAULT_TAX_SETTINGS[key.split(".")[1]] ?? null;
  try {
    const value = await getCachedSetting("platform", null, key, fallback);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export async function taxSettings() {
  const [tcsRate, tdsRate, tcsEnabled, tdsEnabled] = await Promise.all([
    setting("tax.tcsRate"),
    setting("tax.tdsRate"),
    setting("tax.tcsEnabled"),
    setting("tax.tdsEnabled"),
  ]);
  return normaliseSettings({ tcsRate, tdsRate, tcsEnabled, tdsEnabled });
}

function normaliseSettings(s = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    tcsRate: num(s.tcsRate, DEFAULT_TAX_SETTINGS.tcsRate),
    tdsRate: num(s.tdsRate, DEFAULT_TAX_SETTINGS.tdsRate),
    tcsEnabled: s.tcsEnabled === undefined || s.tcsEnabled === null ? true : Boolean(s.tcsEnabled),
    tdsEnabled: s.tdsEnabled === undefined || s.tdsEnabled === null ? true : Boolean(s.tdsEnabled),
  };
}

/** Rupees -> integer paise. */
export const toPaise = (rupees) => Math.round((Number(rupees) || 0) * 100);
const pct = (basePaise, rate) => Math.max(0, Math.round((basePaise * (Number(rate) || 0)) / 100));

/** "intra" | "inter" for the order's seller -> buyer supply (seller snapshot vs ship-to state). */
export function orderSupplyType(order) {
  const seller = order?.sellerSnapshot || {};
  return supplyTypeFor(seller.state, order?.addressSnapshot?.state, {
    sellerGstin: seller.gstin || "",
    buyerGstin: order?.buyerSnapshot?.gstin || "",
  });
}

/** Seller's taxable value of the order in paise: goods (after coupon) + own delivery fee. */
export function sellerTaxableValuePaise(order) {
  let goods = 0;
  const items = order?.items || [];
  const hasShares = items.some((i) => i.couponShare);
  items.forEach((item, idx) => {
    if (item.taxableValue != null) {
      goods += toPaise(item.taxableValue);
      return;
    }
    let net = Number(item.lineSubtotal ?? (item.unitPrice || 0) * (item.qty || 0)) - Number(item.couponShare || 0);
    if (!hasShares && idx === items.length - 1) net -= Number(order.couponDiscount || 0);
    goods += toPaise(splitInclusive(Math.max(0, net), item.taxRate || 0).taxableValue);
  });
  const delivery = Number(order?.deliveryFee || 0) > 0 ? toPaise(splitInclusive(order.deliveryFee, FEE_TAX_RATE).taxableValue) : 0;
  return Math.max(0, goods + delivery);
}

function computeOn(basePaise, supplyType, settings) {
  const s = normaliseSettings(settings || DEFAULT_TAX_SETTINGS);
  const base = Math.max(0, Math.round(Number(basePaise) || 0));
  const tcs = { igst: 0, cgst: 0, sgst: 0, total: 0 };
  if (s.tcsEnabled && base > 0) {
    if (supplyType === "intra") {
      tcs.cgst = pct(base, s.tcsRate / 2);
      tcs.sgst = pct(base, s.tcsRate / 2);
    } else {
      tcs.igst = pct(base, s.tcsRate);
    }
    tcs.total = tcs.igst + tcs.cgst + tcs.sgst;
  }
  const tds = s.tdsEnabled && base > 0 ? pct(base, s.tdsRate) : 0;
  return { base, supplyType, tcs, tds };
}

/** TCS / TDS for a whole seller order. `settings` from taxSettings() (defaults when omitted). */
export function withholdingFor(order, settings) {
  return computeOn(sellerTaxableValuePaise(order), orderSupplyType(order), settings);
}

/**
 * Same shape for the refunded part of an order (reversal entries). `taxableValuePaise` = the
 * seller taxable value refunded (goods + any refunded share of the seller's own delivery fee).
 */
export function withholdingForRefund(order, { taxableValuePaise = 0 } = {}, settings) {
  return computeOn(taxableValuePaise, orderSupplyType(order), settings);
}
