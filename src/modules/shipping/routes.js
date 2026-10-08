import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { checkServiceability, delhiveryWebhookSecret } from "./delhivery.js";
import { applyCarrierUpdate } from "../orders/service.js";

/** Mounted at /api/v1/shipping (see report: needs `v1.use("/shipping", shippingRouter)`). */
const router = Router();

function secretMatches(given) {
  const expected = delhiveryWebhookSecret();
  if (!expected) return false;
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Delhivery status push. Auth: shared secret in `x-delhivery-secret` (DELHIVERY_WEBHOOK_SECRET).
 * Accepts a single shipment ({ Shipment: {...} }) or a list ({ ShipmentData: [{ Shipment }] }).
 */
router.post(
  "/delhivery/webhook",
  asyncHandler(async (req, res) => {
    if (!delhiveryWebhookSecret()) throw new AppError(503, "Delhivery webhook secret is not configured", "SHIPMENT_UNAVAILABLE");
    if (!secretMatches(req.get("x-delhivery-secret"))) throw new AppError(401, "Invalid webhook secret", "UNAUTHORIZED");
    const body = req.body || {};
    const list = Array.isArray(body.ShipmentData) ? body.ShipmentData : [body];
    const results = [];
    for (const row of list.slice(0, 100)) {
      const s = row?.Shipment || row || {};
      const status = s.Status || {};
      results.push(
        await applyCarrierUpdate({
          waybill: s.AWB || s.Waybill || s.waybill,
          status: status.Status || s.status,
          statusType: status.StatusType || "",
          location: status.StatusLocation || "",
          at: status.StatusDateTime || null,
        })
      );
    }
    res.json({ ok: true, results });
  })
);

router.get(
  "/serviceability",
  authenticate,
  validate(z.object({ query: z.object({ pin: z.string().regex(/^\d{6}$/) }).passthrough() })),
  asyncHandler(async (req, res) => {
    res.json(await checkServiceability(req.query.pin));
  })
);

export default router;
