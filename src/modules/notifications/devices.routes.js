import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { DeviceToken, MAX_DEVICES_PER_USER } from "./device.model.js";

/**
 * Phase 6 device registry for mobile push (mounted at /api/v1/devices, any signed-in user):
 *   POST   /devices { token, platform: android|ios, app: buyer|rider, appVersion? } -> 201 device
 *          (same token again -> 200, refreshed; a token held by another user moves to the caller)
 *   GET    /devices                -> { data: [device] } (own; token shown as its last 8 chars)
 *   DELETE /devices/:token         -> { ok, removed }  (call on logout; also DELETE /devices { token })
 */

function present(row) {
  return {
    id: row._id,
    platform: row.platform,
    app: row.app,
    appVersion: row.appVersion || "",
    tokenSuffix: String(row.token || "").slice(-8),
    lastSeenAt: row.lastSeenAt,
    lastPushAt: row.lastPushAt,
    createdAt: row.createdAt,
  };
}

const tokenSchema = z.string().trim().min(10).max(4096);
const router = Router();
router.use(authenticate);

router.post(
  "/",
  validate(
    z.object({
      body: z
        .object({
          token: tokenSchema,
          platform: z.enum(["android", "ios"]),
          app: z.enum(["buyer", "rider"]),
          appVersion: z.string().max(40).optional(),
        })
        .strict(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { token, platform, app, appVersion = "" } = req.body;
    const existing = await DeviceToken.findOne({ token }).lean();
    const row = await DeviceToken.findOneAndUpdate(
      { token },
      {
        $set: {
          userId: req.user._id,
          tenantId: req.user.tenantId?._id || req.user.tenantId || null,
          platform,
          app,
          appVersion,
          lastSeenAt: new Date(),
          failures: 0,
          lastError: "",
        },
      },
      { upsert: true, new: true }
    );
    // Keep the newest MAX_DEVICES_PER_USER devices of the user.
    const extra = await DeviceToken.find({ userId: req.user._id }).sort({ lastSeenAt: -1 }).skip(MAX_DEVICES_PER_USER).select("_id").lean();
    if (extra.length) await DeviceToken.deleteMany({ _id: { $in: extra.map((r) => r._id) } });
    res.status(existing && String(existing.userId) === String(req.user._id) ? 200 : 201).json(present(row));
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await DeviceToken.find({ userId: req.user._id }).sort({ lastSeenAt: -1 }).lean();
    res.json({ data: rows.map(present) });
  })
);

async function removeToken(req, res) {
  const token = String(req.params.token || req.body?.token || "").trim();
  const out = await DeviceToken.deleteOne({ token, userId: req.user._id });
  res.json({ ok: true, removed: out.deletedCount || 0 });
}

router.delete("/:token", validate(z.object({ params: z.object({ token: tokenSchema }) })), asyncHandler(removeToken));
router.delete("/", validate(z.object({ body: z.object({ token: tokenSchema }).strict() })), asyncHandler(removeToken));

export default router;
