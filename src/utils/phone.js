/**
 * Indian phone / website format checks shared by the tenant + user validators (QA R5 / R9).
 * Values are validated, not rewritten: stored phones keep the format the user typed.
 *
 * Phone: a 10-digit mobile starting 6-9 (optional +91 / 91 / 0 prefix), or a landline with its
 * STD code: 0 + 9-10 digits (10-11 digits in all), or +91 followed by the STD code without the 0.
 * Spaces, dashes and brackets are allowed as separators.
 */
export const PHONE_MESSAGE = "Enter a valid Indian phone number (10-digit mobile, or landline with STD code)";

export function isIndianPhone(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\+?[0-9][0-9\s\-()]*$/.test(s)) return false;
  let d = s.replace(/\D/g, "");
  const intl = s.startsWith("+");
  if (intl) {
    if (!d.startsWith("91")) return false;
    d = d.slice(2);
  } else if (d.length === 12 && d.startsWith("91")) {
    d = d.slice(2);
  }
  if (/^0?[6-9]\d{9}$/.test(d)) return true; // mobile
  if (/^0[1-9]\d{8,9}$/.test(d)) return true; // landline: 0 + STD code + number
  if (intl && /^[1-9]\d{8,9}$/.test(d)) return true; // +91 landline without the trunk 0
  return false;
}

export const URL_MESSAGE = "Enter a full web address starting with http:// or https://";

/** http(s) URL with a dotted host name (e.g. https://shop.example.in). */
export function isHttpUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname);
  } catch {
    return false;
  }
}
