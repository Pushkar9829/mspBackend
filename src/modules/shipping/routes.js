import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { checkServiceability, delhiveryWebhookSecret } from "./delhivery.js";
import { parseShiprocketTime, shiprocketWebhookToken } from "./shiprocket.js";
import { applyCarrierUpdate } from "../orders/service.js";

/** Mounted at /api/v1/shipping (see report: needs `v1.use("/shipping", shippingRouter)`). */
const router = Router();

function secretMatches(given, expected) {
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
    if (!secretMatches(req.get("x-delhivery-secret"), delhiveryWebhookSecret())) throw new AppError(401, "Invalid webhook secret", "UNAUTHORIZED");
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

/**
 * Shiprocket tracking push. Auth: `x-api-key` = SHIPROCKET_WEBHOOK_TOKEN.
 * Path stays /events so the URL does not contain "shiprocket" (their webhook setup rejects that).
 */
router.post(
  "/events",
  asyncHandler(async (req, res) => {
    if (!shiprocketWebhookToken()) throw new AppError(503, "Carrier webhook token is not configured", "SHIPMENT_UNAVAILABLE");
    if (!secretMatches(req.get("x-api-key"), shiprocketWebhookToken())) throw new AppError(401, "Invalid webhook token", "UNAUTHORIZED");
    const body = req.body || {};
    const result = await applyCarrierUpdate({
      waybill: body.awb,
      externalOrderId: body.sr_order_id ? String(body.sr_order_id) : "",
      status: body.current_status || body.shipment_status || body["sr-status-label"],
      statusType: body.shipment_status_id || body.current_status_id || body["sr-status"],
      location: body.location || "",
      at: parseShiprocketTime(body.current_timestamp),
      carrier: "shiprocket",
    });
    res.json({ ok: true, result });
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
