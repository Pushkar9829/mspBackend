import { SearchTerm } from "./searchTerm.model.js";
import { SearchHistory } from "./searchHistory.model.js";
import { Category } from "../catalog/category.model.js";
import { Brand } from "../catalog/brand.model.js";
import { Product } from "../catalog/product.model.js";
import { activeTenantIds } from "../catalog/service.js";

const MAX_TERM = 80;
const RECENT_LIMIT = 8;
const POPULAR_LIMIT = 10;
const HISTORY_KEEP = 24;
const THROTTLE_MS = 2 * 60 * 1000;

export function normalizeQuery(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value != null && typeof value === "object") return null;
  const display = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_TERM);
  const term = display.toLowerCase();
  if (term.length < 2) return null;
  return { term, display };
}

const GUEST_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const GUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function searchIdentity(req) {
  if (req.user?._id) return { userId: req.user._id, guestKey: "" };
  const raw = req.headers["x-guest-key"] ? String(req.headers["x-guest-key"]).trim() : "";
  return { userId: null, guestKey: GUEST_KEY.test(raw) ? raw : "" };
}

function historyFilter(identity) {
  if (identity.userId) return { userId: identity.userId };
  if (identity.guestKey) return { guestKey: identity.guestKey, userId: null };
  return null;
}

/**
 * Record a search in the caller's history (signed-in users, or guests with a valid X-Guest-Key;
 * guest rows expire via TTL) and bump the popular-terms counter. Only signed-in users bump
 * popularity (guests are anonymous and could poison the list); the route is also rate-limited.
 */
export async function recordSearch(req, raw) {
  const parsed = normalizeQuery(raw);
  if (!parsed) return { ok: false };
  const identity = searchIdentity(req);
  const filter = historyFilter(identity);

  let bump = Boolean(identity.userId);
  if (filter) {
    const now = new Date();
    const previous = await SearchHistory.findOneAndUpdate(
      { ...filter, term: parsed.term },
      {
        $set: {
          display: parsed.display,
          searchedAt: now,
          expiresAt: identity.userId ? null : new Date(now.getTime() + GUEST_TTL_MS),
        },
        $setOnInsert: { userId: identity.userId, guestKey: identity.guestKey, term: parsed.term },
      },
      { upsert: true, new: false }
    );
    if (previous && now.getTime() - previous.searchedAt.getTime() < THROTTLE_MS) bump = false;
    const extras = await SearchHistory.find(filter).sort({ searchedAt: -1 }).skip(HISTORY_KEEP).select("_id");
    if (extras.length) {
      await SearchHistory.deleteMany({ _id: { $in: extras.map((row) => row._id) } });
    }
  }

  if (bump) {
    await SearchTerm.updateOne(
      { term: parsed.term },
      {
        $inc: { count: 1 },
        $set: { display: parsed.display, lastSearchedAt: new Date() },
        $setOnInsert: { term: parsed.term },
      },
      { upsert: true }
    ).catch((err) => {
      if (err?.code !== 11000) throw err;
    });
  }

  return { ok: true, term: parsed.term, display: parsed.display };
}

export async function listRecent(req) {
  const filter = historyFilter(searchIdentity(req));
  if (!filter) return [];
  const rows = await SearchHistory.find(filter).sort({ searchedAt: -1 }).limit(40);
  const seen = new Set();
  const recent = [];
  for (const row of rows) {
    if (seen.has(row.term)) continue;
    seen.add(row.term);
    recent.push({ term: row.term, display: row.display });
    if (recent.length >= RECENT_LIMIT) break;
  }
  return recent;
}

async function catalogFallback(limit, exclude) {
  const [cats, brands, products] = await Promise.all([
    Category.find({ status: "active", parentId: null }).select("name").sort({ sortOrder: 1 }).limit(8).lean(),
    Brand.find({ status: "active" }).select("name").limit(12).lean(),
    activeTenantIds().then((tenantIds) =>
      Product.find({ status: "published", enabled: { $ne: false }, tenantId: { $in: tenantIds } })
        .select("name tags")
        .sort({ createdAt: -1 })
        .limit(24)
        .lean()
    ),
  ]);
  const out = [];
  const seen = new Set(exclude);
  function push(raw) {
    const parsed = normalizeQuery(raw);
    if (!parsed || seen.has(parsed.term)) return;
    seen.add(parsed.term);
    out.push({ term: parsed.term, display: parsed.display, count: 0 });
  }
  for (const b of brands) push(b.name);
  for (const c of cats) push(c.name);
  for (const p of products) {
    for (const tag of p.tags || []) push(tag);
  }
  return out.slice(0, limit);
}

export async function listPopular(excludeTerms = []) {
  const exclude = new Set(excludeTerms.map((t) => String(t).toLowerCase()));
  const rows = await SearchTerm.find(exclude.size ? { term: { $nin: [...exclude] } } : {})
    .sort({ count: -1, lastSearchedAt: -1 })
    .limit(POPULAR_LIMIT)
    .lean();
  const popular = rows
    .filter((row) => row.count > 0)
    .map((row) => ({ term: row.term, display: row.display, count: row.count }));
  if (popular.length >= POPULAR_LIMIT) return popular;
  const fill = await catalogFallback(POPULAR_LIMIT - popular.length, new Set([...exclude, ...popular.map((p) => p.term)]));
  return [...popular, ...fill];
}

export async function suggestions(req) {
  const recent = await listRecent(req);
  const popular = await listPopular(recent.map((r) => r.term));
  return { recent, popular };
}

export async function removeRecent(req, raw) {
  const parsed = normalizeQuery(raw);
  const filter = historyFilter(searchIdentity(req));
  if (!parsed || !filter) return { ok: true };
  await SearchHistory.deleteMany({ ...filter, term: parsed.term });
  return { ok: true };
}

export async function clearRecent(req) {
  const filter = historyFilter(searchIdentity(req));
  if (!filter) return { ok: true };
  await SearchHistory.deleteMany(filter);
  return { ok: true };
}
