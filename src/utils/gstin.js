/**
 * GSTIN validation: 15 chars = 2-digit state code, 10-char PAN, entity number, "Z", check char.
 * The check character is the GSTN mod-36 checksum over the first 14 characters.
 */
const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = CHARSET.indexOf(first14[i]);
    if (value < 0) return null;
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

/** Normalised (trimmed, upper-case) GSTIN when valid (format + state code + check digit), else null. */
export function normalizeGstin(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!GSTIN_FORMAT.test(value)) return null;
  const state = Number(value.slice(0, 2));
  if (state < 1 || state > 38) return null;
  return gstinCheckChar(value.slice(0, 14)) === value[14] ? value : null;
}

export function isValidGstin(raw) {
  return normalizeGstin(raw) !== null;
}
