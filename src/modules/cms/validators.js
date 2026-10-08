import { z } from "zod";
import { CMS_PAGE_TYPES } from "./cmsPage.model.js";
import { CMS_STATUSES } from "../../config/constants.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const MAX_SECTIONS_BYTES = 256 * 1024;

const section = z.record(z.string(), z.any());
const sections = z
  .array(section)
  .max(100)
  .refine((s) => JSON.stringify(s).length <= MAX_SECTIONS_BYTES, { message: "sections too large (max 256KB)" });

const seo = z
  .object({
    title: z.string().max(200).optional(),
    description: z.string().max(500).optional(),
    canonical: z.string().max(500).optional(),
  })
  .strict();

const pageFields = {
  title: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(80).optional(),
  type: z.enum(CMS_PAGE_TYPES).optional(),
  sections: sections.optional(),
  seo: seo.optional(),
  scheduledAt: z.coerce.date().nullable().optional(),
  // platform admins only (enforced in the service)
  global: z.boolean().optional(),
  tenantId: objectId.nullable().optional(),
};

const body = (schema) => z.preprocess((v) => v ?? {}, schema);

export const createPageSchema = z.object({ body: body(z.object(pageFields).strict()) });

/** Optimistic concurrency: the page version the client edited (alternative to the If-Match header). */
const expectedVersion = z.number().int().min(0).optional();

export const updatePageSchema = z.object({
  params: z.object({ id: objectId }),
  body: body(
    z
      .object({ ...pageFields, expectedVersion })
      .partial()
      .strict()
      .refine((b) => Object.keys(b).filter((k) => k !== "expectedVersion").length > 0, { message: "Nothing to update" })
  ),
});

export const transitionSchema = z.object({
  params: z.object({ id: objectId }),
  body: body(z.object({ expectedVersion }).strict()),
});

export const scheduleSchema = z.object({
  params: z.object({ id: objectId }),
  body: body(
    z
      .object({ scheduledAt: z.coerce.date().nullable(), expectedVersion })
      .strict()
  ),
});

export const idSchema = z.object({ params: z.object({ id: objectId }) });

export const adminListSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      type: z.enum(CMS_PAGE_TYPES).optional(),
      status: z.enum(CMS_STATUSES).optional(),
      q: z.string().max(100).optional(),
      includeGlobal: z.enum(["true", "false"]).optional(),
      globalOnly: z.enum(["true", "false"]).optional(),
    })
    .passthrough(),
});

/** Public store reference: tenantId (id), tenantSlug (slug) or tenant (either). */
const publicTenantQuery = {
  tenantId: objectId.optional(),
  tenantSlug: z.string().trim().min(1).max(80).optional(),
  tenant: z.string().trim().min(1).max(80).optional(),
};

export const publicListSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      type: z.enum(CMS_PAGE_TYPES).optional(),
      ...publicTenantQuery,
    })
    .passthrough(),
});

export const publicSlugSchema = z.object({
  params: z.object({ slug: z.string().min(1).max(80) }),
  query: z.object(publicTenantQuery).passthrough(),
});
