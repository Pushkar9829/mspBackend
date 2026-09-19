import { getSetting } from "./service.js";
import { round2 } from "../pricing/engine.js";

export const DEFAULT_DELIVERY_PARTNERS = [
  { id: "msp", name: "MS₹ Delivery", fee: 0, isDefault: true },
  { id: "delhivery", name: "Delhivery", fee: 40, isDefault: false },
  { id: "bluedart", name: "Blue Dart", fee: 55, isDefault: false },
];

export function normalizePartners(raw) {
  const list = Array.isArray(raw) && raw.length ? raw : DEFAULT_DELIVERY_PARTNERS;
  const cleaned = list.map((partner, index) => ({
    id: String(partner?.id || `partner-${index + 1}`),
    name: String(partner?.name || "Delivery partner"),
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
  const [feeEnabled, feeAmount, feePercent, partnerChoice, partners] = await Promise.all([
    readCommerceValue(tenantId, "platform.feeEnabled", false),
    readCommerceValue(tenantId, "platform.feeAmount", 10),
    readCommerceValue(tenantId, "platform.feePercent", 0),
    readCommerceValue(tenantId, "platform.deliveryPartnerChoiceEnabled", true),
    readCommerceValue(tenantId, "platform.deliveryPartners", DEFAULT_DELIVERY_PARTNERS),
  ]);
  return {
    feeEnabled: Boolean(feeEnabled),
    feeAmount: Math.max(0, Number(feeAmount) || 0),
    feePercent: Math.max(0, Number(feePercent) || 0),
    deliveryPartnerChoiceEnabled: Boolean(partnerChoice),
    deliveryPartners: normalizePartners(partners),
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

export function computePlatformFee(commerce, subtotal) {
  if (!commerce?.feeEnabled) return 0;
  return round2((commerce.feeAmount || 0) + Number(subtotal || 0) * ((commerce.feePercent || 0) / 100));
}

export function publicCommerce(commerce) {
  return {
    platformFeeEnabled: Boolean(commerce.feeEnabled),
    platformFeeAmount: commerce.feeAmount || 0,
    platformFeePercent: commerce.feePercent || 0,
    deliveryPartnerChoiceEnabled: Boolean(commerce.deliveryPartnerChoiceEnabled),
    deliveryPartners: commerce.deliveryPartners,
  };
}
