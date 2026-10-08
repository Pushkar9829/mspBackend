import { getCommerceSettings, deliveryInfo } from "../settings/commerce.js";
import { getCachedSetting, supportEmail } from "../settings/service.js";
import { settingDefinition } from "../settings/registry.js";

/**
 * Settings-backed {{tokens}} for public CMS pages, filled at render time so seeded help / policy
 * text never contradicts configuration:
 *   {{supportEmail}}      platform.supportEmail (else SUPPORT_EMAIL; "our support team" when unset)
 *   {{platformName}}      platform.name
 *   {{etaDaysMin}} {{etaDaysMax}} {{etaDays}} ("2–7", or "3" when equal)
 *                         with a store: its delivery zones; without: delivery.etaDays, else the
 *                         platform estimate (same as GET /settings/public `delivery`)
 *   {{returnWindowDays}}  returns.windowDays
 * Unknown tokens are left as they are. The admin API always returns the raw tokens.
 */
export const CMS_TOKENS = ["supportEmail", "platformName", "etaDays", "etaDaysMin", "etaDaysMax", "returnWindowDays"];
const TOKEN_RX = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

export async function cmsTokenValues(tenantId = null) {
  const commerce = await getCommerceSettings(tenantId || null);
  const [email, name, delivery] = await Promise.all([
    supportEmail(),
    getCachedSetting("platform", null, "platform.name", null),
    deliveryInfo(commerce, tenantId || null),
  ]);
  const min = delivery.etaDaysMin;
  const max = delivery.etaDaysMax;
  return {
    supportEmail: email || "our support team",
    platformName: String(name || settingDefinition("platform.name")?.default || "").trim(),
    etaDaysMin: String(min),
    etaDaysMax: String(max),
    etaDays: min === max ? String(min) : `${min}–${max}`,
    returnWindowDays: String(commerce.returnWindowDays),
  };
}

export function fillTokens(value, values) {
  if (typeof value === "string") {
    return value.replace(TOKEN_RX, (whole, key) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole));
  }
  if (Array.isArray(value)) return value.map((v) => fillTokens(v, values));
  if (value && typeof value === "object" && !(value instanceof Date) && value.constructor === Object) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fillTokens(v, values);
    return out;
  }
  return value;
}

const HAS_TOKEN = /\{\{\s*[a-zA-Z]+\s*\}\}/;

/** A page (document or plain object) with its title, sections and seo filled in. */
export async function renderPage(page, tenantId = null) {
  const plain = typeof page?.toObject === "function" ? page.toObject() : { ...page };
  const subject = { title: plain.title, sections: plain.sections, seo: plain.seo };
  if (!HAS_TOKEN.test(JSON.stringify(subject))) return plain;
  const values = await cmsTokenValues(tenantId || plain.tenantId || null);
  const filled = fillTokens(JSON.parse(JSON.stringify(subject)), values);
  return { ...plain, ...filled };
}
