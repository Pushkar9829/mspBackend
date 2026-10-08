/**
 * Typo-tolerant fallback for storefront search (GET /products/search).
 *
 * The catalog search first runs MongoDB $text (exact / stemmed words) and, for zero hits, an
 * escaped substring regex. When that finds fewer than FEW_RESULTS products, `alternateSearch`
 * tries, in order:
 *   1. synonyms: common Indian grocery transliterations (aata → atta, chawal → rice, …);
 *   2. fuzzy: each unknown query word is corrected against a cached term dictionary built from
 *      published product names / tags, brand names and category names (trigram candidates, then
 *      a bounded Damerau-Levenshtein distance).
 * The alternate query always contains the original words too, so it is a superset of the primary
 * result; it is used only when it finds more products. Everything is bounded: ≤ 6 query words,
 * ≤ 30 chars each, ≤ 60 scored candidates per word, a capped dictionary, and a handful of counts.
 *
 * The dictionary is rebuilt lazily: after DICT_TTL_MS, or when the in-process catalog version
 * (bumped by Product / Brand / Category write hooks) moved and the last build is older than
 * DICT_MIN_REBUILD_MS. Builds are single-flight.
 */
import { Product } from "../catalog/product.model.js";
import { Brand } from "../catalog/brand.model.js";
import { Category } from "../catalog/category.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { catalogVersion } from "./catalogVersion.js";

export const FEW_RESULTS = 3;
const MAX_TOKENS = 6;
const MAX_TOKEN_LEN = 30;
const MAX_PRODUCTS = 50000;
const MAX_TERMS = 50000;
const MAX_POSTINGS_SCANNED = 5000;
const MAX_SCORED = 60;
const DICT_TTL_MS = 10 * 60 * 1000;
const DICT_MIN_REBUILD_MS = 30 * 1000;

/**
 * Equivalent spellings / translations. A query word in a group also searches every other member.
 * Single words only ($text and the regex fallback work per word).
 */
export const SYNONYM_GROUPS = [
  ["atta", "aata", "aatta", "flour"],
  ["rice", "chawal", "chaawal", "chawl"],
  ["dal", "daal", "dhal", "lentil", "lentils"],
  ["ghee", "ghi"],
  ["turmeric", "haldi"],
  ["chilli", "chili", "chillies", "mirchi", "mirch"],
  ["tea", "chai", "chay"],
  ["soap", "sabun", "saabun"],
  ["salt", "namak"],
  ["sugar", "cheeni", "chini", "shakkar"],
  ["oil", "tel", "tael"],
  ["cumin", "jeera", "zeera", "jira"],
  ["coriander", "dhania", "dhaniya"],
  ["besan", "gramflour"],
  ["semolina", "sooji", "suji", "rava", "rawa"],
  ["milk", "doodh", "dudh"],
  ["paneer", "panir"],
  ["potato", "aloo", "alu"],
  ["onion", "pyaz", "pyaaz", "kanda"],
  ["tomato", "tamatar"],
  ["jaggery", "gud", "gur"],
  ["cardamom", "elaichi", "ilaichi"],
  ["clove", "cloves", "laung", "lavang"],
  ["fenugreek", "methi"],
  ["mustard", "sarson", "rai"],
  ["asafoetida", "hing", "heeng"],
  ["carom", "ajwain", "ajwan"],
  ["biscuit", "biscuits", "cookies"],
  ["detergent", "washing"],
  ["curd", "dahi", "yogurt", "yoghurt"],
  ["butter", "makhan", "makkhan"],
  ["peanut", "peanuts", "moongphali", "mungfali"],
  ["chickpea", "chickpeas", "chana", "channa", "chole"],
  ["kidney", "rajma"],
  ["vermicelli", "sevai", "seviyan"],
  ["flattened", "poha"],
];

const synonymIndex = new Map();
for (const group of SYNONYM_GROUPS) for (const term of group) synonymIndex.set(term, group);

export function synonymsOf(term) {
  return synonymIndex.get(term) || null;
}

/** Lower-case, accent-free alphanumeric words of length ≥ 2. */
export function tokenize(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && t.length <= MAX_TOKEN_LEN);
}

function trigrams(term) {
  const padded = `$${term}$`;
  const out = new Set();
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return [...out];
}

/** Optimal-string-alignment distance (adjacent transpositions count as 1), or max + 1 once it exceeds `max`. */
export function editDistance(a, b, max = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** Edits allowed for a word of this length (shorter words tolerate fewer). */
function maxEditsFor(len) {
  if (len < 3) return 0;
  if (len <= 4) return 1;
  if (len <= 8) return 2;
  return 3;
}

/* ------------------------------------------------------------------ dictionary */

let dict = null; // { terms, df, grams, builtAt, version }
let building = null;

async function buildDictionary() {
  const version = catalogVersion();
  const tenantIds = await Tenant.find({ status: { $in: ["active", "trial"] } }).distinct("_id");
  const df = new Map();
  const add = (text, weight = 1) => {
    for (const t of new Set(tokenize(text))) {
      if (/\d/.test(t)) continue; // pack sizes / SKUs are not spelling-corrected
      df.set(t, (df.get(t) || 0) + weight);
    }
  };
  const brandUse = new Map();
  const categoryUse = new Map();
  const cursor = Product.find({ tenantId: { $in: tenantIds }, status: "published", enabled: { $ne: false } })
    .select("name tags brandId categoryId")
    .limit(MAX_PRODUCTS)
    .lean()
    .cursor();
  for await (const p of cursor) {
    add(`${p.name || ""} ${(p.tags || []).join(" ")}`);
    if (p.brandId) brandUse.set(String(p.brandId), (brandUse.get(String(p.brandId)) || 0) + 1);
    if (p.categoryId) categoryUse.set(String(p.categoryId), (categoryUse.get(String(p.categoryId)) || 0) + 1);
  }
  const [brands, categories] = await Promise.all([
    brandUse.size ? Brand.find({ _id: { $in: [...brandUse.keys()] } }).select("name").lean() : [],
    categoryUse.size ? Category.find({ _id: { $in: [...categoryUse.keys()] } }).select("name").lean() : [],
  ]);
  for (const b of brands) add(b.name, brandUse.get(String(b._id)) || 1);
  for (const c of categories) add(c.name, categoryUse.get(String(c._id)) || 1);
  // Synonym spellings are always correctable targets (weight 0: catalog words win ties).
  for (const term of synonymIndex.keys()) if (!df.has(term)) df.set(term, 0);

  const terms = [...df.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TERMS)
    .map(([t]) => t);
  const kept = new Map(terms.map((t) => [t, df.get(t)]));
  const grams = new Map();
  terms.forEach((term, idx) => {
    for (const g of trigrams(term)) {
      if (!grams.has(g)) grams.set(g, []);
      grams.get(g).push(idx);
    }
  });
  return { terms, df: kept, grams, builtAt: Date.now(), version };
}

/** The cached term dictionary, rebuilt when stale (see module doc). */
export async function getDictionary() {
  const age = dict ? Date.now() - dict.builtAt : Infinity;
  const stale = !dict || age > DICT_TTL_MS || (dict.version !== catalogVersion() && age > DICT_MIN_REBUILD_MS);
  if (!stale) return dict;
  if (!building) {
    building = buildDictionary()
      .then((d) => {
        dict = d;
        return d;
      })
      .finally(() => {
        building = null;
      });
  }
  // Within the TTL the previous dictionary keeps serving while a change-triggered rebuild runs.
  if (dict && age <= DICT_TTL_MS) {
    building.catch(() => {});
    return dict;
  }
  return building;
}

/** Drop the cached dictionary (tests; or after a bulk import). */
export function invalidateSearchDictionary() {
  dict = null;
}

/** Best dictionary correction of an unknown word: { term, distance } or null. */
export function correctToken(d, token) {
  if (!d || d.df.has(token) || synonymIndex.has(token) || /\d/.test(token)) return null;
  const max = maxEditsFor(token.length);
  if (!max) return null;
  const grams = trigrams(token);
  const shared = new Map();
  for (const g of grams) {
    const postings = d.grams.get(g);
    if (!postings) continue;
    const n = Math.min(postings.length, MAX_POSTINGS_SCANNED);
    for (let i = 0; i < n; i += 1) shared.set(postings[i], (shared.get(postings[i]) || 0) + 1);
  }
  const scored = [];
  for (const [idx, count] of shared) {
    const term = d.terms[idx];
    if (Math.abs(term.length - token.length) > max) continue;
    const dice = (2 * count) / (grams.length + term.length); // a word of length L has ≤ L padded trigrams
    scored.push({ term, dice });
  }
  scored.sort((a, b) => b.dice - a.dice);
  let best = null;
  for (const { term, dice } of scored.slice(0, MAX_SCORED)) {
    const distance = editDistance(token, term, max);
    if (distance > max) continue;
    const df = d.df.get(term) || 0;
    if (!best || distance < best.distance || (distance === best.distance && (df > best.df || (df === best.df && dice > best.dice)))) {
      best = { term, distance, df, dice };
    }
  }
  return best ? { term: best.term, distance: best.distance } : null;
}

/** The member of a synonym group to show in "did you mean": the one the catalog uses most. */
function displaySynonym(group, d, original) {
  const others = group.filter((t) => t !== original);
  const used = others.filter((t) => (d?.df.get(t) || 0) > 0).sort((a, b) => d.df.get(b) - d.df.get(a));
  return used[0] || others[0] || original;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Query clause for a set of words: $text when it matches (relevance sort), else a word-start
 * regex on name / tags plus brand and category names.
 */
async function clauseForTerms(terms, count) {
  const text = { $text: { $search: terms.join(" ") } };
  const n = await count(text);
  if (n > 0) return { clause: text, textScore: true, count: n };
  const rx = new RegExp(`(^|[^a-z0-9])(${terms.map(escapeRegex).join("|")})`, "i");
  const [brandIds, categoryIds] = await Promise.all([
    Brand.find({ name: rx }).select("_id").limit(200).lean(),
    Category.find({ name: rx }).select("_id").limit(200).lean(),
  ]).then((rows) => rows.map((list) => list.map((row) => row._id)));
  const or = [{ name: rx }, { tags: rx }];
  if (brandIds.length) or.push({ brandId: { $in: brandIds } });
  if (categoryIds.length) or.push({ categoryId: { $in: categoryIds } });
  const clause = { $or: or };
  return { clause, textScore: false, count: await count(clause) };
}

/**
 * Synonym, then fuzzy, alternative for a query whose primary search found `primaryCount` (<
 * FEW_RESULTS) products. `count(clause)` counts products matching the search's other filters plus
 * `clause`. Returns { clause, textScore, matchedBy: "synonym"|"fuzzy", didYouMean, count } or null
 * when nothing better was found.
 */
export async function alternateSearch(q, primaryCount, count) {
  const tokens = [...new Set(tokenize(q))].slice(0, MAX_TOKENS);
  if (!tokens.length) return null;
  const d = await getDictionary();
  let best = null;

  // 1. Synonyms of the words as typed.
  if (tokens.some((t) => synonymIndex.has(t))) {
    const terms = new Set(tokens);
    const shown = tokens.map((t) => {
      const group = synonymIndex.get(t);
      if (!group) return t;
      group.forEach((s) => terms.add(s));
      // A word the catalogue itself uses is not "corrected" in the suggestion.
      return (d?.df.get(t) || 0) > 0 ? t : displaySynonym(group, d, t);
    });
    const result = await clauseForTerms([...terms], count);
    const suggestion = shown.join(" ");
    if (result.count > primaryCount) {
      best = { ...result, matchedBy: "synonym", didYouMean: suggestion !== tokens.join(" ") ? suggestion : null };
    }
  }

  // 2. Spelling corrections of unknown words (plus synonyms of the corrected words).
  const corrected = tokens.map((t) => correctToken(d, t)?.term || t);
  if (corrected.some((t, i) => t !== tokens[i])) {
    const terms = new Set([...tokens, ...corrected]);
    for (const t of corrected) (synonymIndex.get(t) || []).forEach((s) => terms.add(s));
    const result = await clauseForTerms([...terms], count);
    if (result.count > Math.max(primaryCount, best?.count || 0)) {
      best = { ...result, matchedBy: "fuzzy", didYouMean: corrected.join(" ") };
    }
  }
  return best;
}
