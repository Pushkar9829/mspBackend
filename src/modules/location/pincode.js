import { env } from "../../config/env.js";

/**
 * PIN code → { pincode, city, district, state, stateCode, approximate, source }.
 *
 * 1. Google Geocoding (components=postal_code|country:IN) when the maps provider is configured
 *    (`platform.mapsProvider` = "google" and MAPS_API_KEY): exact, `approximate: false`.
 * 2. Otherwise a small bundled table: the postal circle (state / UT) from the first 2-3 digits,
 *    plus the main city for well-known metro sorting districts (first 3 digits). This is NOT a
 *    full PIN database, so the result is always `approximate: true`; `city`/`district` are null
 *    when the prefix is not a known metro.
 * `stateCode` is the ISO 3166-2:IN subdivision code without the "IN-" prefix (MH, DL, KA, ...).
 */

/** ISO 3166-2:IN codes. */
const STATES = {
  AN: "Andaman and Nicobar Islands",
  AP: "Andhra Pradesh",
  AR: "Arunachal Pradesh",
  AS: "Assam",
  BR: "Bihar",
  CH: "Chandigarh",
  CT: "Chhattisgarh",
  DH: "Dadra and Nagar Haveli and Daman and Diu",
  DL: "Delhi",
  GA: "Goa",
  GJ: "Gujarat",
  HP: "Himachal Pradesh",
  HR: "Haryana",
  JH: "Jharkhand",
  JK: "Jammu and Kashmir",
  KA: "Karnataka",
  KL: "Kerala",
  LA: "Ladakh",
  LD: "Lakshadweep",
  MH: "Maharashtra",
  ML: "Meghalaya",
  MN: "Manipur",
  MP: "Madhya Pradesh",
  MZ: "Mizoram",
  NL: "Nagaland",
  OD: "Odisha",
  PB: "Punjab",
  PY: "Puducherry",
  RJ: "Rajasthan",
  SK: "Sikkim",
  TG: "Telangana",
  TN: "Tamil Nadu",
  TR: "Tripura",
  UK: "Uttarakhand",
  UP: "Uttar Pradesh",
  WB: "West Bengal",
};

/** Postal circles by the first two digits. */
const BY_2 = {
  11: "DL",
  12: "HR", 13: "HR",
  14: "PB", 15: "PB", 16: "PB",
  17: "HP",
  18: "JK", 19: "JK",
  20: "UP", 21: "UP", 22: "UP", 23: "UP", 24: "UP", 25: "UP", 26: "UP", 27: "UP", 28: "UP",
  30: "RJ", 31: "RJ", 32: "RJ", 33: "RJ", 34: "RJ",
  36: "GJ", 37: "GJ", 38: "GJ", 39: "GJ",
  40: "MH", 41: "MH", 42: "MH", 43: "MH", 44: "MH",
  45: "MP", 46: "MP", 47: "MP", 48: "MP",
  49: "CT",
  50: "TG",
  51: "AP", 52: "AP", 53: "AP",
  56: "KA", 57: "KA", 58: "KA", 59: "KA",
  60: "TN", 61: "TN", 62: "TN", 63: "TN", 64: "TN",
  67: "KL", 68: "KL", 69: "KL",
  70: "WB", 71: "WB", 72: "WB", 73: "WB", 74: "WB",
  75: "OD", 76: "OD", 77: "OD",
  78: "AS",
  79: "AS",
  80: "BR", 81: "BR", 82: "BR", 83: "BR", 84: "BR", 85: "BR",
};

/** Three-digit exceptions inside a two-digit circle. */
const BY_3 = {
  160: "CH",
  194: "LA",
  246: "UK", 248: "UK", 249: "UK", 263: "UK",
  403: "GA",
  605: "PY",
  682: "KL",
  737: "SK",
  744: "AN",
  790: "AR", 791: "AR", 792: "AR",
  793: "ML", 794: "ML",
  795: "MN",
  796: "MZ",
  797: "NL", 798: "NL",
  799: "TR",
  814: "JH", 815: "JH", 816: "JH", 822: "JH", 825: "JH", 826: "JH", 827: "JH", 828: "JH", 829: "JH",
  831: "JH", 832: "JH", 833: "JH", 834: "JH", 835: "JH",
};

/** Main city (and district) of well-known sorting districts, by the first three digits. */
const METROS = {
  110: ["New Delhi", "New Delhi"],
  121: ["Faridabad", "Faridabad"],
  122: ["Gurugram", "Gurugram"],
  141: ["Ludhiana", "Ludhiana"],
  143: ["Amritsar", "Amritsar"],
  160: ["Chandigarh", "Chandigarh"],
  201: ["Ghaziabad", "Ghaziabad"],
  208: ["Kanpur", "Kanpur Nagar"],
  211: ["Prayagraj", "Prayagraj"],
  221: ["Varanasi", "Varanasi"],
  226: ["Lucknow", "Lucknow"],
  248: ["Dehradun", "Dehradun"],
  250: ["Meerut", "Meerut"],
  282: ["Agra", "Agra"],
  302: ["Jaipur", "Jaipur"],
  380: ["Ahmedabad", "Ahmedabad"],
  390: ["Vadodara", "Vadodara"],
  395: ["Surat", "Surat"],
  400: ["Mumbai", "Mumbai"],
  411: ["Pune", "Pune"],
  422: ["Nashik", "Nashik"],
  431: ["Chhatrapati Sambhajinagar", "Chhatrapati Sambhajinagar"],
  440: ["Nagpur", "Nagpur"],
  452: ["Indore", "Indore"],
  462: ["Bhopal", "Bhopal"],
  492: ["Raipur", "Raipur"],
  500: ["Hyderabad", "Hyderabad"],
  520: ["Vijayawada", "NTR"],
  530: ["Visakhapatnam", "Visakhapatnam"],
  560: ["Bengaluru", "Bengaluru Urban"],
  570: ["Mysuru", "Mysuru"],
  575: ["Mangaluru", "Dakshina Kannada"],
  600: ["Chennai", "Chennai"],
  625: ["Madurai", "Madurai"],
  641: ["Coimbatore", "Coimbatore"],
  682: ["Kochi", "Ernakulam"],
  695: ["Thiruvananthapuram", "Thiruvananthapuram"],
  700: ["Kolkata", "Kolkata"],
  751: ["Bhubaneswar", "Khordha"],
  781: ["Guwahati", "Kamrup Metropolitan"],
  800: ["Patna", "Patna"],
  834: ["Ranchi", "Ranchi"],
};

/** ISO code (without "IN-") → state / UT name. */
export const INDIAN_STATES = Object.freeze({ ...STATES });

/** Older / informal codes and names → ISO code. */
const STATE_ALIASES = {
  TS: "TG", OR: "OD", UA: "UK", CG: "CT", DN: "DH", DD: "DH", PD: "PY", PO: "PY", JD: "JH", NCT: "DL",
  orissa: "OD", pondicherry: "PY", telengana: "TG", uttaranchal: "UK", chattisgarh: "CT", chhatisgarh: "CT",
  "new delhi": "DL", "nct of delhi": "DL", "delhi ncr": "DL", "national capital territory of delhi": "DL",
  "j&k": "JK", "jammu & kashmir": "JK", "andaman & nicobar islands": "AN", "andaman and nicobar": "AN",
  "dadra and nagar haveli": "DH", "daman and diu": "DH", "dadra & nagar haveli and daman & diu": "DH",
  "tamilnadu": "TN", "west bengal": "WB", "westbengal": "WB",
};

/**
 * Normalise a state input ("DL", "dl", "Delhi", "New Delhi", "Orissa", "TS") to
 * { state: full name, stateCode: ISO code }. Unknown input is returned trimmed with stateCode null.
 */
export function normalizeIndianState(input) {
  const raw = String(input ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return { state: "", stateCode: null };
  const upper = raw.toUpperCase().replace(/^IN-/, "");
  const lower = raw.toLowerCase();
  const code =
    (STATES[upper] && upper) ||
    stateCodeByName.get(lower) ||
    STATE_ALIASES[upper] ||
    STATE_ALIASES[lower] ||
    stateCodeByName.get(lower.replace(/&/g, "and")) ||
    null;
  return code ? { state: STATES[code], stateCode: code } : { state: raw, stateCode: null };
}

export const PINCODE_RX = /^[1-9][0-9]{5}$/;

const stateCodeByName = new Map(Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code]));

/** Offline, approximate lookup from the bundled prefix tables. */
export function lookupPincodeOffline(pin) {
  const code = String(pin);
  const p3 = Number(code.slice(0, 3));
  const p2 = Number(code.slice(0, 2));
  const stateCode = BY_3[p3] || BY_2[p2] || null;
  const metro = METROS[p3] || null;
  return {
    pincode: code,
    city: metro ? metro[0] : null,
    district: metro ? metro[1] : null,
    state: stateCode ? STATES[stateCode] : null,
    stateCode,
    approximate: true,
    found: Boolean(stateCode),
    source: "prefix",
  };
}

async function useGoogle() {
  if (!env.mapsApiKey) return false;
  try {
    const { mapsProvider } = await import("../settings/service.js");
    return (await mapsProvider(env.mapsProvider || "google")) === "google";
  } catch {
    return false;
  }
}

const cache = new Map();
const CACHE_MAX = 2000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function lookupGoogle(pin) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("components", `postal_code:${pin}|country:IN`);
  url.searchParams.set("key", env.mapsApiKey);
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  const data = await res.json();
  const hit = data.results?.[0];
  if (!hit) return null;
  const part = (type) => hit.address_components?.find((c) => c.types?.includes(type)) || null;
  const state = part("administrative_area_level_1");
  const district = part("administrative_area_level_3") || part("administrative_area_level_2");
  const city = part("locality") || part("postal_town") || part("sublocality") || district;
  const stateName = state?.long_name || null;
  const shortCode = state?.short_name && /^[A-Z]{2}$/.test(state.short_name) ? state.short_name : null;
  return {
    pincode: pin,
    city: city?.long_name || null,
    district: district?.long_name || null,
    state: stateName,
    stateCode: (stateName && stateCodeByName.get(stateName.toLowerCase())) || shortCode,
    approximate: false,
    found: true,
    source: "google",
  };
}

/**
 * Look up a 6-digit PIN code. Never throws for provider failures (falls back to the offline table).
 * Callers validate the format first (PINCODE_RX).
 */
export async function lookupPincode(pin) {
  const code = String(pin);
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let value = null;
  if (await useGoogle()) {
    try {
      value = await lookupGoogle(code);
    } catch {
      value = null;
    }
  }
  if (!value) value = lookupPincodeOffline(code);
  // Fill gaps from the offline table (e.g. Google without a state code).
  if (!value.stateCode || !value.state) {
    const offline = lookupPincodeOffline(code);
    value = { ...value, state: value.state || offline.state, stateCode: value.stateCode || offline.stateCode };
  }
  cache.set(code, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}

/** Test hook. */
export function clearPincodeCache() {
  cache.clear();
}
