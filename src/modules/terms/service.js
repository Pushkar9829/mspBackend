import { getSetting } from "../settings/service.js";
import { settingDefinition } from "../settings/registry.js";

export const SELLER_TERMS_KEY = "seller.termsVersion";

const DEFAULT_TEXT =
  "By selling on MS₹ you confirm that your business details, GST and PAN information and bank account are true and belong to you, " +
  "that you hold every licence your products need (including an FSSAI licence for food), that you will ship orders on time, honour " +
  "returns and refunds as per the marketplace policies, and that the platform may suspend your store for policy violations.";

/** Current seller terms: { version, url, text }. Platform setting `seller.termsVersion` (object or bare version string). */
export async function currentSellerTerms() {
  const fallback = settingDefinition(SELLER_TERMS_KEY)?.default || { version: "2026-10-01", url: "", text: "" };
  const raw = await getSetting("platform", null, SELLER_TERMS_KEY, null);
  const value = typeof raw === "string" ? { version: raw } : raw && typeof raw === "object" ? raw : {};
  const version = String(value.version || fallback.version).trim();
  return {
    version,
    url: String(value.url ?? fallback.url ?? ""),
    text: String(value.text || fallback.text || DEFAULT_TEXT),
  };
}
