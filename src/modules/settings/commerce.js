import { getSetting, getCachedSetting } from "./service.js";
import { round2, FEE_TAX_RATE } from "../pricing/engine.js";
import { Tenant } from "../tenants/tenant.model.js";

import { DEFAULT_DELIVERY_PARTNERS, DEFAULT_ETA_DAYS } from "./defaults.js";
import { repairMojibake } from "../../utils/mojibake.js";

export { DEFAULT_DELIVERY_PARTNERS };

export function normalizePartners(raw) {
  const list = Array.isArray(raw) && raw.length ? raw : DEFAULT_DELIVERY_PARTNERS;
  const cleaned = list.map((partner, index) => ({
    id: String(partner?.id || `partner-${index + 1}`),
    // Read-time guard for values stored double-encoded (e.g. "MSâ‚¹ Delivery"); the startup
    // migration (runStorefrontMigrations) fixes the stored rows.
    name: repairMojibake(String(partner?.name || "Delivery partner")),
    fee: Math.max(0, Number(partner?.fee) || 0),
    isDefault: Boolean(partner?.isDefault),
  }));
  if (!cleaned.some((partner) => partner.isDefault)) cleaned[0].isDefault = true;
  return cleaned;
}

async function readCommerceValue(tenantId, key, fallback) {
  if (tenantId) {
    const tenantValue = await getSetting("tenant", tenantId, key, undefined);
    if (tenantValue !== undefined && tenantValue !== null) return tenantValue;
  }
  return getSetting("platform", null, key, fallback);
}

export async function getCommerceSettings(tenantId = null) {
  const [feeEnabled, feeAmount, feePercent, partnerChoice, partners, platformCod, storeCod, freeAbove, returnsOn, returnDays] = await Promise.all([
    readCommerceValue(tenantId, "platform.feeEnabled", false),
    readCommerceValue(tenantId, "platform.feeAmount", 10),
    readCommerceValue(tenantId, "platform.feePercent", 0),
    readCommerceValue(tenantId, "platform.deliveryPartnerChoiceEnabled", true),
    readCommerceValue(tenantId, "platform.deliveryPartners", DEFAULT_DELIVERY_PARTNERS),
    getSetting("platform", null, "payments.codEnabled", true),
    tenantId ? getSetting("tenant", tenantId, "payments.codEnabled", true) : true,
    tenantId ? getSetting("tenant", tenantId, "delivery.freeAbove", 0) : 0,
    getSetting("platform", null, "returns.enabled", true),
    getSetting("platform", null, "returns.windowDays", 7),
  ]);
  return {
    feeEnabled: Boolean(feeEnabled),
    feeAmount: Math.max(0, Number(feeAmount) || 0),
    feePercent: Math.max(0, Number(feePercent) || 0),
    deliveryPartnerChoiceEnabled: Boolean(partnerChoice),
    deliveryPartners: normalizePartners(partners),
    /** COD needs both the platform admin and the store to allow it. */
    platformCodEnabled: platformCod !== false,
    storeCodEnabled: storeCod !== false,
    codEnabled: platformCod !== false && storeCod !== false,
    /** Store promotion: no delivery or partner fee once the order (after coupon) reaches this. 0 = off. */
    freeDeliveryAbove: Math.max(0, Number(freeAbove) || 0),
    /** One return policy for the whole platform; it covers items marked "Easy return". */
    returnsEnabled: returnsOn !== false,
    returnWindowDays: Math.max(1, Number(returnDays) || 7),
  };
}

export function pickPartner(partners, id, choiceEnabled = true) {
  const list = normalizePartners(partners);
  if (choiceEnabled && id) {
    const chosen = list.find((partner) => partner.id === id);
    if (chosen) return chosen;
  }
  return list.find((partner) => partner.isDefault) || list[0];
}

/** `includeFlat` is false for every seller after the first so the flat fee is charged once per checkout. */
export function computePlatformFee(commerce, subtotal, { includeFlat = true } = {}) {
  if (!commerce?.feeEnabled) return 0;
  const flat = includeFlat ? commerce.feeAmount || 0 : 0;
  return round2(flat + Number(subtotal || 0) * ((commerce.feePercent || 0) / 100));
}

export function publicCommerce(commerce) {
  return {
    platformFeeEnabled: Boolean(commerce.feeEnabled),
    platformFeeAmount: commerce.feeAmount || 0,
    platformFeePercent: commerce.feePercent || 0,
    deliveryPartnerChoiceEnabled: Boolean(commerce.deliveryPartnerChoiceEnabled),
    deliveryPartners: commerce.deliveryPartners,
    codEnabled: Boolean(commerce.codEnabled),
    freeDeliveryAbove: commerce.freeDeliveryAbove || 0,
    returnsEnabled: commerce.returnsEnabled !== false,
    returnWindowDays: commerce.returnWindowDays || 7,
  };
}

const ETA_TTL_MS = 5 * 60 * 1000;
let etaCache = { at: 0, value: null };

/** Test hook / call after zone edits if the 5-minute cache matters. */
export function invalidatePlatformEta() {
  etaCache = { at: 0, value: null };
}

/**
 * Platform-level delivery estimate for the storefront when no store is selected:
 * 1. the platform setting `delivery.etaDays` when an admin stored one (source "setting");
 * 2. else an aggregate over active/trial stores' delivery zones: the fastest zone minimum and the
 *    median zone maximum (source "stores");
 * 3. else the registry default { etaDaysMin: 2, etaDaysMax: 7 } (source "default").
 * The aggregate is cached for 5 minutes.
 */
export async function platformEta() {
  const stored = await getCachedSetting("platform", null, "delivery.etaDays", null);
  const min = Number(stored?.etaDaysMin);
  const max = Number(stored?.etaDaysMax);
  if (Number.isFinite(min) && Number.isFinite(max) && min <= max) {
    return { etaDaysMin: min, etaDaysMax: max, source: "setting" };
  }
  if (etaCache.value && Date.now() - etaCache.at < ETA_TTL_MS) return etaCache.value;
  const [row] = await Tenant.aggregate([
    { $match: { status: { $in: ["active", "trial"] } } },
    { $unwind: "$deliveryZones" },
    { $match: { "deliveryZones.etaDaysMin": { $type: "number" }, "deliveryZones.etaDaysMax": { $type: "number" } } },
    { $group: { _id: null, min: { $min: "$deliveryZones.etaDaysMin" }, maxes: { $push: "$deliveryZones.etaDaysMax" } } },
  ]);
  let value;
  if (row?.maxes?.length) {
    const sorted = row.maxes.map(Number).sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    value = { etaDaysMin: row.min, etaDaysMax: Math.max(row.min, median), source: "stores" };
  } else {
    value = { ...DEFAULT_ETA_DAYS, source: "default" };
  }
  etaCache = { at: Date.now(), value };
  return value;
}

/**
 * Storefront delivery messaging: free-delivery threshold, the default partner fee, and (for a
 * store) its delivery zones' fee + ETA. Fees are GST-inclusive (feeTaxRate %). Used by
 * GET /settings/public (`delivery`) and the product page (GET /products/lookup).
 */
export async function deliveryInfo(commerce, tenantId = null) {
  const partner = pickPartner(commerce.deliveryPartners, null, false);
  let zones = [];
  if (tenantId) {
    const tenant = await Tenant.findById(tenantId).select("deliveryZones").lean();
    zones = (tenant?.deliveryZones || []).map((z) => ({
      name: z.name || "",
      deliveryFee: Number(z.deliveryFee) || 0,
      etaDaysMin: z.etaDaysMin ?? null,
      etaDaysMax: z.etaDaysMax ?? null,
    }));
  }
  const fees = zones.map((z) => z.deliveryFee);
  const etaMin = zones.map((z) => z.etaDaysMin).filter((n) => n != null);
  const etaMax = zones.map((z) => z.etaDaysMax).filter((n) => n != null);
  const platform = tenantId ? null : await platformEta();
  return {
    freeDeliveryAbove: commerce.freeDeliveryAbove || 0,
    freeDeliveryEnabled: (commerce.freeDeliveryAbove || 0) > 0,
    defaultPartner: partner ? { id: partner.id, name: partner.name, fee: partner.fee } : null,
    partnerFee: partner?.fee || 0,
    zoneFeeMin: fees.length ? Math.min(...fees) : 0,
    zoneFeeMax: fees.length ? Math.max(...fees) : 0,
    etaDaysMin: etaMin.length ? Math.min(...etaMin) : tenantId ? 3 : platform.etaDaysMin,
    etaDaysMax: etaMax.length ? Math.max(...etaMax) : tenantId ? 7 : platform.etaDaysMax,
    /** "zones" | "store_default" (store without zones) | "setting" | "stores" | "default" (no store). */
    etaSource: etaMin.length || etaMax.length ? "zones" : tenantId ? "store_default" : platform.source,
    zones,
    codEnabled: Boolean(commerce.codEnabled),
    feeTaxRate: FEE_TAX_RATE,
    feesIncludeGst: true,
  };
}
