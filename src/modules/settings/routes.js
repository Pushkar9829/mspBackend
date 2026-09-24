import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize, authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";
import { getCommerceSettings, publicCommerce } from "./commerce.js";

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

export const settingsPublicRouter = Router();
settingsPublicRouter.get(
  "/public",
  asyncHandler(async (_req, res) => {
    const [name, slogan, commerce, festival] = await Promise.all([
      service.getSetting("platform", null, "platform.name", "MSP Wholesale Marketplace"),
      service.getSetting("platform", null, "platform.slogan", "भाव भी भरोसा भी"),
      getCommerceSettings(),
      service.getSetting("platform", null, "platform.festival", null),
    ]);
    res.json({ name, slogan, festival: liveFestival(festival), ...publicCommerce(commerce) });
  })
);

const router = Router();
router.use(authenticate, resolveTenant, authorizeAny("settings.view", "settings.edit", "tenants.edit", "notifications.manage"));

router.get("/", asyncHandler(async (req, res) => {
  res.json(await service.listSettings(req));
}));
router.get("/commerce", asyncHandler(async (req, res) => {
  res.json(await getCommerceSettings(req.tenantId || null));
}));
router.put(
  "/:key",
  authorize("settings.edit"),
  audit("upsert", "settings"),
  asyncHandler(async (req, res) => {
    res.json(await service.upsertSetting(req, req.params.key, req.body.value));
  })
);

export default router;
