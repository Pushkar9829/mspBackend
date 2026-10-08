/**
 * Repair "mojibake": UTF-8 text that was decoded as Windows-1252 (or Latin-1) and re-encoded as
 * UTF-8, e.g. "MS₹ Delivery" stored as "MSâ‚¹ Delivery". Only strings that contain the typical
 * marker characters are touched, and a repair is kept only when it decodes cleanly, so valid text
 * (Hindi, "₹", accents) is never changed.
 */

/** Windows-1252 code points for bytes 0x80-0x9F (the rest of 0x00-0xFF map 1:1 to U+0000-U+00FF). */
const CP1252 = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** A UTF-8 lead byte (Ã, Â, â, à, ...) rendered as cp1252, followed by a continuation-byte character. */
export const MOJIBAKE_MARKER = /[\u00c2-\u00f4][\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/;

/**
 * The same pattern with literal characters instead of escapes, for MongoDB $regex queries
 * (the server's PCRE2 rejects JavaScript-style unicode escapes).
 */
export const MOJIBAKE_MARKER_DB = new RegExp(
  MOJIBAKE_MARKER.source.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return ch === "-" || ch === "]" || ch === "^" ? `\\${ch}` : ch;
  })
);

const decoder = new TextDecoder("utf-8", { fatal: true });

function repairOnce(value) {
  const bytes = [];
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code <= 0xff) bytes.push(code);
    else if (CP1252[code] !== undefined) bytes.push(CP1252[code]);
    else return null; // a real non-Latin character: not a cp1252 round-trip
  }
  try {
    return decoder.decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

export function hasMojibake(value) {
  return typeof value === "string" && MOJIBAKE_MARKER.test(value);
}

/** Undo up to two rounds of UTF-8 → cp1252 → UTF-8 double encoding. Returns the input when nothing applies. */
export function repairMojibake(value) {
  if (!hasMojibake(value)) return value;
  let out = value;
  for (let i = 0; i < 2 && hasMojibake(out); i += 1) {
    const fixed = repairOnce(out);
    if (fixed == null || fixed === out) break;
    out = fixed;
  }
  return out;
}

/** Deep-repair every string in a JSON-like value. Returns { value, changed }. */
export function repairDeep(value) {
  if (typeof value === "string") {
    const fixed = repairMojibake(value);
    return { value: fixed, changed: fixed !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = repairDeep(item);
      changed ||= r.changed;
      return r.value;
    });
    return { value: changed ? out : value, changed };
  }
  if (value && typeof value === "object" && !(value instanceof Date) && value.constructor === Object) {
    let changed = false;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = repairDeep(v);
      changed ||= r.changed;
      out[k] = r.value;
    }
    return { value: changed ? out : value, changed };
  }
  return { value, changed: false };
}
