import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { audit } from "../../middleware/audit.js";
import * as service from "./service.js";
import { getPreferences, updatePreferences, unsubscribeWithToken } from "./preferences.js";
import { listSchema, idSchema, announcementSchema, preferencesSchema, unsubscribeSchema } from "./validators.js";

const router = Router();

const unsubscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests", code: "RATE_LIMIT" },
});

/** Public: one-click unsubscribe from a signed email link (no login needed). */
router.post(
  "/unsubscribe",
  unsubscribeLimiter,
  validate(unsubscribeSchema),
  asyncHandler(async (req, res) => {
    res.json(await unsubscribeWithToken(req.body.token));
  })
);

// resolveTenant lets marketplace buyers (no tenant) through with req.tenantId = null.
router.use(authenticate, resolveTenant);

router.get("/", validate(listSchema), asyncHandler(async (req, res) => {
  res.json(await service.listMine(req));
}));
router.get("/unread-count", asyncHandler(async (req, res) => {
  res.json(await service.unreadCount(req));
}));
router.post("/read-all", asyncHandler(async (req, res) => {
  res.json(await service.markAllRead(req));
}));
router.get("/preferences", asyncHandler(async (req, res) => {
  res.json(await getPreferences(req.user._id));
}));
router.put("/preferences", validate(preferencesSchema), asyncHandler(async (req, res) => {
  res.json(await updatePreferences(req.user._id, req.body));
}));
router.get("/sent", authorize("notifications.send"), validate(listSchema), asyncHandler(async (req, res) => {
  res.json(await service.listSent(req));
}));
router.post("/:id/read", validate(idSchema), asyncHandler(async (req, res) => {
  res.json(await service.markRead(req, req.params.id));
}));
router.post("/:id/cancel", audit("cancel_announcement", "notification"), authorize("notifications.send"), validate(idSchema), asyncHandler(async (req, res) => {
  res.json(await service.cancelScheduled(req, req.params.id));
}));
router.post(
  "/",
  audit("announce", "notification"),
  authorize("notifications.send"),
  validate(announcementSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createAnnouncement(req, req.body));
  })
);

export default router;
