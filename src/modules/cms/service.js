import { CmsPage } from "./cmsPage.model.js";
import { AppError } from "../../utils/AppError.js";
import { slugify } from "../../utils/slug.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { emitDomain } from "../../utils/events.js";

export async function listPages(req, { publicOnly = false } = {}) {
  const { page, limit, skip } = paginate(req.query);
  const filter = publicOnly
    ? { status: "published", ...(req.query.tenantId ? { tenantId: req.query.tenantId } : { tenantId: null }) }
    : tenantFilter(req);
  if (req.query.type) filter.type = req.query.type;
  if (req.query.status && !publicOnly) filter.status = req.query.status;
  const [data, total] = await Promise.all([
    CmsPage.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit),
    CmsPage.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}

export async function getBySlug(slug, tenantId = null) {
  const page = await CmsPage.findOne({ slug, tenantId: tenantId || null, status: "published" });
  if (!page) throw new AppError(404, "Page not found", "NOT_FOUND");
  return page;
}

export async function createPage(req, body) {
  const slug = slugify(body.slug || body.title);
  return CmsPage.create({
    ...body,
    slug,
    tenantId: req.isPlatformAdmin && body.global ? null : req.tenantId,
  });
}

export async function updatePage(req, id, body) {
  const page = await CmsPage.findOne({ _id: id, ...tenantFilter(req) });
  if (!page) throw new AppError(404, "Page not found", "NOT_FOUND");
  page.versions.push({
    actorId: req.user._id,
    snapshot: { title: page.title, sections: page.sections, status: page.status },
  });
  if (body.slug) body.slug = slugify(body.slug);
  Object.assign(page, body);
  await page.save();
  return page;
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
