import mongoose from "mongoose";
import { CmsPage } from "./cmsPage.model.js";
import { CmsPageVersion, MAX_CMS_VERSIONS } from "./cmsPageVersion.model.js";
import { sanitizeSections, sanitizeValue } from "./sanitize.js";
import { Tenant } from "../tenants/tenant.model.js";
import { AppError } from "../../utils/AppError.js";
import { slugify } from "../../utils/slug.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { emitDomain } from "../../utils/events.js";
import { renderPage } from "./render.js";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasPerm(req, perm) {
  const perms = req.permissions || [];
  return perms.includes("*") || perms.includes(perm);
}

function adminScope(req) {
  if (!req.isPlatformAdmin && !req.tenantId) throw new AppError(403, "Tenant context required", "FORBIDDEN");
  return tenantFilter(req);
}

/**
 * Resolve the public `tenantId` / `tenantSlug` / `tenant` (id or slug) query to a tenant id.
 * Returns null for "global pages"; throws 404 for an unknown or inactive store.
 */
export async function resolvePublicTenant({ tenantId, tenantSlug, tenant } = {}) {
  const raw = tenantId || tenantSlug || tenant;
  if (!raw) return null;
  const key = String(raw).trim();
  const byId = mongoose.isValidObjectId(key) && /^[a-f0-9]{24}$/i.test(key);
  const doc = await Tenant.findOne({
    ...(byId ? { _id: key } : { slug: key.toLowerCase() }),
    status: { $in: ["active", "trial"] },
  })
    .select("_id")
    .lean();
  if (!doc) throw new AppError(404, "Store not found", "NOT_FOUND");
  return doc._id;
}

export async function listPages(req, { publicOnly = false } = {}) {
  const { page, limit, skip } = paginate(req.query);
  let filter;
  if (publicOnly) {
    filter = { status: "published", tenantId: await resolvePublicTenant(req.query) };
  } else {
    filter = adminScope(req);
    // includeGlobal=true: one store's pages together with the global (platform) pages.
    if (filter.tenantId && String(req.query.includeGlobal) === "true") filter.tenantId = { $in: [filter.tenantId, null] };
    else if (req.isPlatformAdmin && !req.tenantId && String(req.query.globalOnly) === "true") filter.tenantId = null;
  }
  if (req.query.type) filter.type = req.query.type;
  if (req.query.status && !publicOnly) filter.status = req.query.status;
  if (req.query.q && !publicOnly && String(req.query.q).trim()) {
    const rx = new RegExp(escapeRegex(String(req.query.q).trim()), "i");
    filter.$or = [{ title: rx }, { slug: rx }];
  }
  const query = CmsPage.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit);
  if (publicOnly) query.select("-sections");
  else query.populate("tenantId", "name slug");
  const [rows, total] = await Promise.all([query.lean(), CmsPage.countDocuments(filter)]);
  const data = rows.map((p) => ({ ...p, id: p._id, global: !p.tenantId }));
  return paginated(data, total, { page, limit });
}

/** Public slug aliases: a missing page resolves to its alias (both directions). */
export const CMS_SLUG_ALIASES = { returns: "refunds", refunds: "returns" };

async function findPublished(slug, tenantId) {
  const published = { slug, status: "published" };
  if (tenantId) {
    const scoped = await CmsPage.findOne({ ...published, tenantId });
    if (scoped) return scoped;
  }
  return CmsPage.findOne({ ...published, tenantId: null });
}

/**
 * Public page lookup. With `tenantId`: that store's published page, falling back explicitly to
 * the global page (tenantId null) of the same slug. Without: global pages only. Never returns
 * another store's page. A slug with no page resolves through CMS_SLUG_ALIASES (`returns` ↔
 * `refunds`); the response then carries `requestedSlug` and `aliasOf` (= the page's slug) so the
 * client can redirect to the canonical URL. Settings {{tokens}} are filled (cms/render.js).
 */
export async function getBySlug(slug, tenantRef = null) {
  const wanted = String(slug).toLowerCase();
  const tenantId =
    tenantRef && typeof tenantRef === "object" ? await resolvePublicTenant(tenantRef) : tenantRef ? await resolvePublicTenant({ tenant: tenantRef }) : null;
  let page = await findPublished(wanted, tenantId);
  let aliased = false;
  if (!page && CMS_SLUG_ALIASES[wanted]) {
    page = await findPublished(CMS_SLUG_ALIASES[wanted], tenantId);
    aliased = Boolean(page);
  }
  if (!page) throw new AppError(404, "Page not found", "NOT_FOUND");
  const rendered = await renderPage(page, tenantId);
  delete rendered.seedHash;
  delete rendered.seedSource;
  return aliased ? { ...rendered, requestedSlug: wanted, aliasOf: page.slug } : rendered;
}

export async function getPage(req, id) {
  const page = await CmsPage.findOne({ _id: id, ...adminScope(req) }).populate("tenantId", "name slug");
  if (!page) throw new AppError(404, "Page not found", "NOT_FOUND");
  return page;
}

async function resolveTargetTenant(req, body) {
  if (!req.isPlatformAdmin) {
    if (body.global || (body.tenantId !== undefined && String(body.tenantId) !== String(req.tenantId))) {
      throw new AppError(403, "Only platform admins can choose the page owner", "FORBIDDEN");
    }
    return req.tenantId;
  }
  if (body.global) return null;
  if (body.tenantId) {
    const tenant = await Tenant.findById(body.tenantId).select("_id");
    if (!tenant) throw new AppError(404, "Tenant not found", "NOT_FOUND");
    return tenant._id;
  }
  if (body.tenantId === null) return null;
  return req.tenantId || null;
}

function assertSchedulePermission(req, body) {
  if (body.scheduledAt && !hasPerm(req, "cms.publish")) {
    throw new AppError(403, "Scheduling a publish requires cms.publish", "FORBIDDEN");
  }
  if (body.scheduledAt) {
    const at = new Date(body.scheduledAt);
    if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
      throw new AppError(400, "scheduledAt must be in the future", "VALIDATION_ERROR", {
        fields: { scheduledAt: "Must be in the future" },
      });
    }
  }
}

/** Scheduling only makes sense for pages not yet live: draft or in review. */
function assertSchedulable(page) {
  if (page.status === "published" || page.status === "unpublished") {
    throw new AppError(
      409,
      `A ${page.status} page cannot be scheduled. ${page.status === "published" ? "It is already live" : "Move it back to draft first"}.`,
      "INVALID_STATE",
      { fields: { scheduledAt: `Not allowed while the page is ${page.status}` } }
    );
  }
}

/** Parse an expected version from If-Match ("3", W/"3", 3) or body.expectedVersion. */
export function expectedVersionFrom(req, body = {}) {
  if (body.expectedVersion !== undefined && body.expectedVersion !== null) return Number(body.expectedVersion);
  const header = req.headers?.["if-match"];
  if (!header || header === "*") return null;
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(String(header).trim());
  if (!m) throw new AppError(400, "If-Match must be a page version number", "VALIDATION_ERROR");
  return Number(m[1]);
}

function versionConflict(current) {
  return new AppError(409, "Page was modified by someone else; reload and retry", "CONFLICT", { currentVersion: current ?? 0 });
}

function cleanFields(body) {
  const out = {};
  if (body.title !== undefined) out.title = body.title;
  if (body.type !== undefined) out.type = body.type;
  if (body.sections !== undefined) out.sections = sanitizeSections(body.sections);
  if (body.seo !== undefined) out.seo = sanitizeValue(body.seo);
  if (body.scheduledAt !== undefined) out.scheduledAt = body.scheduledAt || null;
  return out;
}

function duplicateSlug(err) {
  if (err?.code === 11000) throw new AppError(409, "A page with this slug already exists", "DUPLICATE");
  throw err;
}

export async function createPage(req, body) {
  assertSchedulePermission(req, body);
  const slug = slugify(body.slug || body.title);
  if (!slug) throw new AppError(400, "slug: invalid", "VALIDATION_ERROR");
  const tenantId = await resolveTargetTenant(req, body);
  // Status is always draft: publishing goes through the publish endpoint (cms.publish).
  const fields = cleanFields(body);
  if (fields.scheduledAt) Object.assign(fields, { scheduledBy: req.user._id, scheduleError: "" });
  return CmsPage.create({ ...fields, slug, tenantId, status: "draft" }).catch(duplicateSlug);
}

/** Move pre-existing embedded `versions` arrays into CmsPageVersion (idempotent). */
async function migrateEmbeddedVersions(pageId) {
  const raw = await CmsPage.collection.findOne(
    { _id: new mongoose.Types.ObjectId(String(pageId)), versions: { $exists: true } },
    { projection: { versions: { $slice: -MAX_CMS_VERSIONS }, tenantId: 1 } }
  );
  if (!raw) return;
  const rows = (raw.versions || []).map((v) => ({
    pageId: raw._id,
    tenantId: raw.tenantId || null,
    actorId: v.actorId || null,
    at: v.at || new Date(),
    snapshot: v.snapshot || {},
  }));
  const res = await CmsPage.collection.updateOne({ _id: raw._id, versions: { $exists: true } }, { $unset: { versions: "" } });
  if (res.modifiedCount && rows.length) await CmsPageVersion.insertMany(rows);
}

async function recordVersion(page, actorId, action = "edit", extra = {}) {
  await CmsPageVersion.create({
    pageId: page._id,
    tenantId: page.tenantId || null,
    version: page.version || 0,
    actorId,
    action,
    ...extra,
    snapshot: {
      title: page.title,
      slug: page.slug,
      type: page.type,
      sections: page.sections,
      seo: page.seo,
      status: page.status,
      scheduledAt: page.scheduledAt || null,
    },
  });
  const stale = await CmsPageVersion.find({ pageId: page._id }).sort({ at: -1 }).skip(MAX_CMS_VERSIONS).select("_id").lean();
  if (stale.length) await CmsPageVersion.deleteMany({ _id: { $in: stale.map((s) => s._id) } });
}

function sameValue(a, b) {
  const norm = (v) => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "object" && typeof v.toObject === "function") return norm(v.toObject());
    if (mongoose.isValidObjectId(v) && typeof v === "object") return String(v);
    return v;
  };
  try {
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  } catch {
    return false;
  }
}

/**
 * PATCH a page. Optimistic concurrency: pass the version you edited (`If-Match: <version>` or
 * body `expectedVersion`) to get 409 CONFLICT if someone changed the page since; without it the
 * update still only applies to the version read here. A PATCH that changes nothing returns the
 * page as-is (no version bump, no version entry). Scheduling needs a future scheduledAt and a
 * draft/review page.
 */
export async function updatePage(req, id, body) {
  assertSchedulePermission(req, body);
  const expected = expectedVersionFrom(req, body);
  const page = await CmsPage.findOne({ _id: id, ...adminScope(req) });
  if (!page) throw new AppError(404, "Page not found", "NOT_FOUND");
  if (expected != null && Number(page.version || 0) !== expected) throw versionConflict(page.version);
  if (page.status === "published" && !hasPerm(req, "cms.publish")) {
    throw new AppError(403, "Editing a published page requires cms.publish", "FORBIDDEN");
  }
  if (body.scheduledAt) assertSchedulable(page);
  await migrateEmbeddedVersions(page._id);
  const $set = cleanFields(body);
  if (body.slug !== undefined) {
    $set.slug = slugify(body.slug);
    if (!$set.slug) throw new AppError(400, "slug: invalid", "VALIDATION_ERROR");
  }
  if (body.tenantId !== undefined || body.global !== undefined) {
    $set.tenantId = await resolveTargetTenant(req, body);
  }
  for (const [key, value] of Object.entries($set)) {
    const current = key === "seo" ? page.seo?.toObject?.() ?? page.seo : page[key];
    if (sameValue(current, value)) delete $set[key];
  }
  if (!Object.keys($set).length) {
    await page.populate("tenantId", "name slug");
    return page; // no-op: version unchanged
  }
  if ($set.scheduledAt) {
    Object.assign($set, { scheduledBy: req.user._id, scheduleError: "" });
  } else if ("scheduledAt" in $set) {
    $set.scheduledBy = null;
  } else if (page.scheduledAt && !hasPerm(req, "cms.publish")) {
    // The publisher approved the content as it was; an edit by someone without cms.publish
    // cancels the pending schedule so unapproved content is never auto-published.
    Object.assign($set, { scheduledAt: null, scheduledBy: null });
  }
  // Optimistic concurrency: only apply if nobody else edited since we read.
  const updated = await CmsPage.findOneAndUpdate(
    { _id: page._id, ...(page.version ? { version: page.version } : { version: { $in: [0, null] } }) },
    { $set, $inc: { version: 1 } },
    { new: true, runValidators: true }
  ).catch(duplicateSlug);
  if (!updated) {
    const fresh = await CmsPage.findById(page._id).select("version").lean();
    throw versionConflict(fresh?.version);
  }
  await recordVersion(page, req.user._id, $set.scheduledAt ? "schedule" : "edit");
  return updated;
}

export async function listVersions(req, id) {
  const page = await CmsPage.findOne({ _id: id, ...adminScope(req) }).select("_id");
  if (!page) throw new AppError(404, "Page not found", "NOT_FOUND");
  await migrateEmbeddedVersions(page._id);
  return CmsPageVersion.find({ pageId: page._id }).sort({ at: -1 }).limit(MAX_CMS_VERSIONS).populate("actorId", "name email").lean();
}

export async function deletePage(req, id) {
  const page = await CmsPage.findOneAndDelete({ _id: id, ...adminScope(req) });
  if (!page) throw new AppError(404, "Page not found", "NOT_FOUND");
  await CmsPageVersion.deleteMany({ pageId: page._id });
  return { ok: true, id: page._id };
}

const TRANSITIONS = {
  review: ["draft", "unpublished"],
  published: ["draft", "review", "unpublished"],
  unpublished: ["published"],
  draft: ["review", "unpublished"],
};

const TRANSITION_ACTION = { review: "review", published: "publish", unpublished: "unpublish", draft: "draft" };

/**
 * Status transition (review / publish / unpublish / back to draft). Each one bumps the page version
 * and writes a version entry (action review|publish|unpublish|draft) with the pre-transition
 * snapshot. Optional expected version (If-Match / body.expectedVersion) → 409 on mismatch.
 */
export async function transition(req, id, status, body = {}) {
  const from = TRANSITIONS[status];
  if (!from) throw new AppError(400, "Invalid status", "VALIDATION_ERROR");
  const expected = expectedVersionFrom(req, body || {});
  const before = await CmsPage.findOne({ _id: id, ...adminScope(req) });
  if (!before) throw new AppError(404, "Page not found", "NOT_FOUND");
  if (expected != null && Number(before.version || 0) !== expected) throw versionConflict(before.version);
  if (!from.includes(before.status)) {
    throw new AppError(409, `Cannot move a ${before.status} page to ${status}`, "INVALID_STATE");
  }
  const now = new Date();
  const $set = { status };
  if (status === "published") Object.assign($set, { publishedAt: now, scheduledAt: null, scheduledBy: null });
  if (status === "unpublished") Object.assign($set, { scheduledAt: null, scheduledBy: null });
  const page = await CmsPage.findOneAndUpdate(
    { _id: before._id, status: before.status, version: before.version || { $in: [0, null] } },
    { $set, $inc: { version: 1 } },
    { new: true }
  );
  if (!page) throw versionConflict((await CmsPage.findById(before._id).select("version").lean())?.version);
  await recordVersion(before, req.user._id, TRANSITION_ACTION[status] || status, { toStatus: status });
  if (status === "published") {
    emitDomain("CMS_PUBLISHED", { tenantId: page.tenantId, resource: "cms", resourceId: page._id, actorId: req.user._id });
  }
  return page;
}

/**
 * Schedule a publish (cms.publish). `scheduledAt` must be in the future and the page must be a
 * draft or in review; `scheduledAt: null` cancels the schedule. Writes a version entry.
 */
export async function schedulePage(req, id, body = {}) {
  const expected = expectedVersionFrom(req, body);
  const before = await CmsPage.findOne({ _id: id, ...adminScope(req) });
  if (!before) throw new AppError(404, "Page not found", "NOT_FOUND");
  if (expected != null && Number(before.version || 0) !== expected) throw versionConflict(before.version);
  const cancel = body.scheduledAt === null;
  if (!cancel) {
    assertSchedulePermission(req, { scheduledAt: body.scheduledAt });
    assertSchedulable(before);
  } else if (!before.scheduledAt) {
    return before;
  }
  const page = await CmsPage.findOneAndUpdate(
    { _id: before._id, version: before.version || { $in: [0, null] } },
    {
      $set: cancel
        ? { scheduledAt: null, scheduledBy: null }
        : { scheduledAt: new Date(body.scheduledAt), scheduledBy: req.user._id, scheduleError: "" },
      $inc: { version: 1 },
    },
    { new: true }
  );
  if (!page) throw versionConflict((await CmsPage.findById(before._id).select("version").lean())?.version);
  await recordVersion(before, req.user._id, cancel ? "unschedule" : "schedule", { scheduledAt: page.scheduledAt });
  return page;
}

/**
 * Why the user who scheduled `page` may no longer publish it ("" when they still may): they must
 * be active, hold cms.publish and still belong to the page's store (global pages: platform only).
 */
async function scheduleRejection(page) {
  if (!page.scheduledBy) return "No scheduler recorded";
  const [{ User }, { Role }, { effectivePermissions, isPlatformRole }] = await Promise.all([
    import("../users/user.model.js"),
    import("../rbac/role.model.js"),
    import("../../middleware/authenticate.js"),
  ]);
  const user = await User.findById(page.scheduledBy).select("status tenantId roleId").lean();
  const role = user ? await Role.findById(user.roleId).lean() : null;
  const platform = isPlatformRole(role);
  const perms = role ? effectivePermissions(role) : [];
  if (!user || user.status !== "active") return "The user who scheduled this page is no longer active";
  const sameStore = platform || (page.tenantId && user.tenantId && String(user.tenantId) === String(page.tenantId));
  if (!sameStore) return "The user who scheduled this page no longer belongs to the store";
  if (!(platform || perms.includes("*") || perms.includes("cms.publish"))) {
    return "The user who scheduled this page no longer holds cms.publish";
  }
  return "";
}

/**
 * Publish due scheduled pages. Each page is claimed atomically (version check), so it is published
 * exactly once. The scheduler's cms.publish is re-checked; if it lapsed the schedule is cancelled
 * (page stays draft/review) with `scheduleError` set.
 */
export async function publishScheduled({ batch = 100 } = {}) {
  let count = 0;
  for (let i = 0; i < batch; i += 1) {
    const now = new Date();
    const page = await CmsPage.findOne({ status: { $in: ["draft", "review"] }, scheduledAt: { $ne: null, $lte: now } })
      .sort({ scheduledAt: 1 })
      .lean();
    if (!page) break;
    const claim = { _id: page._id, status: page.status, scheduledAt: page.scheduledAt, version: page.version || { $in: [0, null] } };
    const reason = await scheduleRejection(page);
    if (reason) {
      await CmsPage.updateOne(claim, { $set: { scheduledAt: null, scheduledBy: null, scheduleError: reason }, $inc: { version: 1 } });
      continue;
    }
    const claimed = await CmsPage.findOneAndUpdate(
      claim,
      { $set: { status: "published", publishedAt: now, scheduledAt: null, scheduledBy: null, scheduleError: "" }, $inc: { version: 1 } },
      { new: false }
    );
    if (!claimed) continue;
    count += 1;
    await recordVersion(claimed, null, "publish", { toStatus: "published", scheduled: true }).catch(() => {});
    emitDomain("CMS_PUBLISHED", { tenantId: claimed.tenantId, resource: "cms", resourceId: claimed._id });
  }
  return count;
}
