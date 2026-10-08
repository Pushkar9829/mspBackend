import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize, authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { validate } from "../../middleware/validate.js";
import { z } from "zod";
import * as service from "./service.js";

const putSchema = z.object({
  params: z.object({ key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*){1,3}$/, "Invalid key") }),
  body: z.preprocess((v) => v ?? {}, z.object({ value: z.any() }).strict()).refine((b) => b.value !== undefined, {
    message: "value is required",
  }),
});
import { getCommerceSettings, publicCommerce, deliveryInfo } from "./commerce.js";
import { FEE_TAX_RATE } from "../pricing/engine.js";
import { Tenant } from "../tenants/tenant.model.js";
import { env } from "../../config/env.js";

function liveFestival(value) {
  if (!value || !value.enabled || !String(value.message || "").trim()) return null;
  const now = Date.now();
  if (value.startsAt && now < new Date(value.startsAt).getTime()) return null;
  if (value.endsAt && now > new Date(value.endsAt).getTime()) return null;
  return {
    title: value.title || "Festival wishes",
    message: String(value.message),
  };
}

const publicQuerySchema = z.object({
  query: z
    .object({
      tenantId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid id").optional(),
      tenantSlug: z.string().trim().min(1).max(80).optional(),
    })
    .passthrough(),
});

/** Public storefront info of one store (active/trial only) or null. */
async function publicStore({ tenantId, tenantSlug }) {
  if (!tenantId && !tenantSlug) return null;
  const tenant = await Tenant.findOne({
    ...(tenantId ? { _id: tenantId } : { slug: String(tenantSlug).toLowerCase() }),
    status: { $in: ["active", "trial"] },
  })
    .select("name slug branding")
    .lean();
  if (!tenant) return null;
  const displayName = String((await service.getCachedSetting("tenant", tenant._id, "store.displayName", "")) || "").trim();
  return {
    id: tenant._id,
    name: tenant.name,
    displayName: displayName || tenant.name,
    slug: tenant.slug,
    branding: tenant.branding || {},
  };
}

export const settingsPublicRouter = Router();
/**
 * Public (no auth) settings: marketplace name, slogan, currency, support email, maps provider,
 * live festival banner and buyer-facing commerce rules. With `tenantId` or `tenantSlug`, the
 * store's overrides apply and `store` = { id, name, displayName, slug, branding }.
 */
settingsPublicRouter.get(
  "/public",
  validate(publicQuerySchema),
  asyncHandler(async (req, res) => {
    const store = await publicStore(req.query);
    const [name, slogan, currency, supportEmail, mapsProvider, commerce, festival] = await Promise.all([
      service.getCachedSetting("platform", null, "platform.name", "MSP Wholesale Marketplace"),
      service.getCachedSetting("platform", null, "platform.slogan", "भाव भी भरोसा भी"),
      service.getCachedSetting("platform", null, "platform.currency", "INR"),
      service.supportEmail(),
      service.mapsProvider(env.mapsProvider || "stub"),
      getCommerceSettings(store?.id || null),
      service.getCachedSetting("platform", null, "platform.festival", null),
    ]);
    res.json({
      name,
      slogan,
      currency: currency || "INR",
      supportEmail,
      mapsProvider,
      festival: liveFestival(festival),
      ...publicCommerce(commerce),
      taxInclusive: true,
      feeTaxRate: FEE_TAX_RATE,
      delivery: await deliveryInfo(commerce, store?.id || null),
      store,
    });
  })
);

const router = Router();
router.use(authenticate, resolveTenant, authorizeAny("settings.view", "settings.edit", "tenants.edit", "notifications.manage"));

router.get("/", asyncHandler(async (req, res) => {
  res.json(await service.listSettings(req));
}));
router.get("/keys", (req, res) => {
  res.json(service.listKeys(req));
});
router.get("/commerce", asyncHandler(async (req, res) => {
  res.json(await getCommerceSettings(req.tenantId || null));
}));
router.put(
  "/:key",
  audit("upsert", "settings"),
  authorize("settings.edit"),
  validate(putSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.upsertSetting(req, req.params.key, req.body.value));
  })
);

const deleteSchema = z.object({
  params: putSchema.shape.params,
  query: z
    .object({
      scope: z.enum(["tenant", "platform"]).optional(),
      tenantId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid id").optional(),
    })
    .passthrough(),
});

/** Remove a store override (falls back to the platform default). */
router.delete(
  "/:key",
  audit("delete_override", "settings"),
  authorize("settings.edit"),
  validate(deleteSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.deleteTenantOverride(req, req.params.key));
  })
);

export default router;
