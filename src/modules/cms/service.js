import { CmsPage } from "./cmsPage.model.js";
import { AppError } from "../../utils/AppError.js";
import { slugify } from "../../utils/slug.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { emitDomain } from "../../utils/events.js";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function listPages(req, { publicOnly = false } = {}) {
  const { page, limit, skip } = paginate(req.query);
  const filter = publicOnly
    ? { status: "published", ...(req.query.tenantId ? { tenantId: req.query.tenantId } : { tenantId: null }) }
    : tenantFilter(req);
  if (req.query.type) filter.type = req.query.type;
  if (req.query.status && !publicOnly) filter.status = req.query.status;
  if (req.query.q && !publicOnly) {
    const rx = new RegExp(escapeRegex(req.query.q.trim()), "i");
    filter.$or = [{ title: rx }, { slug: rx }];
  }
  const [data, total] = await Promise.all([
    CmsPage.find(filter).populate("tenantId", "name slug").sort({ updatedAt: -1 }).skip(skip).limit(limit),
    CmsPage.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}

export async function getBySlug(slug, tenantId = null) {
  const published = { slug, status: "published" };
  if (tenantId) {
    const scoped = await CmsPage.findOne({ ...published, tenantId });
    if (scoped) return scoped;
  }
  const global = await CmsPage.findOne({ ...published, tenantId: null });
  if (global) return global;
  const any = await CmsPage.findOne(published);
  if (!any) throw new AppError(404, "Page not found", "NOT_FOUND");
  return any;
}

export async function createPage(req, body) {
  const slug = slugify(body.slug || body.title);
  let tenantId = req.tenantId || null;
  if (req.isPlatformAdmin) {
    if (body.global) tenantId = null;
    else if (body.tenantId) tenantId = body.tenantId;
  }
  const { global: _global, tenantId: _tenantId, ...fields } = body;
  return CmsPage.create({
    ...fields,
    slug,
    tenantId,
  });
}

export async function updatePage(req, id, body) {
  const page = await CmsPage.findOne({ _id: id, ...tenantFilter(req) });
  if (!page) throw new AppError(404, "Page not found", "NOT_FOUND");
  page.versions.push({
    actorId: req.user._id,
    snapshot: { title: page.title, sections: page.sections, status: page.status },
  });
  const { tenantId, global: _global, ...rest } = body;
  if (rest.slug) rest.slug = slugify(rest.slug);
  Object.assign(page, rest);
  if (req.isPlatformAdmin && tenantId !== undefined) {
    page.tenantId = tenantId || null;
  }
  await page.save();
  return page;
}

export async function deletePage(req, id) {
  const page = await CmsPage.findOne({ _id: id, ...tenantFilter(req) });
  if (!page) throw new AppError(404, "Page not found", "NOT_FOUND");
  await page.deleteOne();
  return { ok: true, id: page._id };
}

export async function transition(req, id, status) {
  const page = await CmsPage.findOne({ _id: id, ...tenantFilter(req) });
  if (!page) throw new AppError(404, "Page not found", "NOT_FOUND");
  page.status = status;
  if (status === "published") {
    page.publishedAt = new Date();
    emitDomain("CMS_PUBLISHED", {
      tenantId: page.tenantId,
      resource: "cms",
      resourceId: page._id,
    });
  }
  await page.save();
  return page;
}

export async function publishScheduled() {
  const due = await CmsPage.find({
    status: "draft",
    scheduledAt: { $lte: new Date(), $ne: null },
  });
  for (const page of due) {
    page.status = "published";
    page.publishedAt = new Date();
    await page.save();
    emitDomain("CMS_PUBLISHED", {
      tenantId: page.tenantId,
      resource: "cms",
      resourceId: page._id,
    });
  }
  return due.length;
}
