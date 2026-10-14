import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize, authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant, requireTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { RIDER_VEHICLE_TYPES, RIDER_ID_PROOF_TYPES, DELIVERY_FAIL_REASONS } from "../../config/constants.js";
import * as service from "./service.js";
import { requestLoginOtp, verifyLoginOtp } from "./otpLogin.js";
import { getEntitlements } from "../billing/entitlements.js";

/**
 * Own delivery fleet (phase 5):
 *   /auth/otp/request, /auth/otp/verify      rider mobile + OTP login (public, rate limited)
 *   /riders...                               seller: riders CRUD + cash      (riders.manage)
 *   /fleet...                                seller: board, tasks, cash      (riders.manage or orders.update)
 *   /rider...                                rider app                       (rider.app, own tasks only)
 */

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const idParams = z.object({ id: objectId });
const phone = z.string().trim().min(10).max(16);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/* ------------------------------------------------------------------ OTP login */

function limiter(windowMs, max, message) {
  return rateLimit({ windowMs, limit: max, standardHeaders: "draft-7", legacyHeaders: false, message: { message, code: "RATE_LIMIT" } });
}
// Per IP (per number: 30 s resend cooldown + 5 wrong tries per code, in otpLogin.js).
export const otpRequestLimiter = limiter(15 * 60 * 1000, 30, "Too many code requests");
export const otpVerifyLimiter = limiter(15 * 60 * 1000, 60, "Too many attempts");

export const otpAuthRouter = Router();
otpAuthRouter.post(
  "/otp/request",
  otpRequestLimiter,
  validate(z.object({ body: z.object({ phone }).strict() })),
  asyncHandler(async (req, res) => {
    res.json(await requestLoginOtp(req.body, req, res));
  })
);
otpAuthRouter.post(
  "/otp/verify",
  audit("login_otp", "auth"),
  otpVerifyLimiter,
  validate(z.object({ body: z.object({ phone, code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") }).strict() })),
  asyncHandler(async (req, res) => {
    res.json(await verifyLoginOtp(req.body, req, res));
  })
);

/* ------------------------------------------------------------------ seller: riders */

const vehicle = z.object({ type: z.enum(RIDER_VEHICLE_TYPES).optional(), number: z.string().trim().max(20).optional() }).strict();
const idProof = z
  .object({
    type: z.enum(RIDER_ID_PROOF_TYPES).optional(),
    number: z.string().trim().max(30).optional(),
    fileId: objectId.nullable().optional(),
  })
  .strict();
const zoneNames = z.array(z.string().trim().min(1).max(80)).max(50);
const riderCreate = z
  .object({
    name: z.string().trim().min(2).max(80),
    phone,
    vehicle: vehicle.optional(),
    idProof: idProof.optional(),
    zoneNames: zoneNames.optional(),
  })
  .strict();
const riderPatch = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    phone: phone.optional(),
    vehicle: vehicle.optional(),
    idProof: idProof.optional(),
    zoneNames: zoneNames.optional(),
  })
  .strict();

export const ridersRouter = Router();
ridersRouter.use(authenticate, resolveTenant, requireTenant, authorize("riders.manage"));

ridersRouter.get("/", asyncHandler(async (req, res) => {
  const list = await service.listRiders(req);
  const ent = await getEntitlements(req.tenantId).catch(() => null);
  res.json({ ...list, limit: ent ? { limit: ent.limits.riders, usage: ent.usage.riders, remaining: ent.remaining.riders } : null });
}));
ridersRouter.post("/", audit("create", "rider"), validate(z.object({ body: riderCreate })), asyncHandler(async (req, res) => {
  res.status(201).json(await service.createRider(req, req.body));
}));
ridersRouter.get("/:id", validate(z.object({ params: idParams })), asyncHandler(async (req, res) => {
  res.json(await service.getRider(req, req.params.id));
}));
ridersRouter.patch("/:id", audit("update", "rider"), validate(z.object({ params: idParams, body: riderPatch })), asyncHandler(async (req, res) => {
  res.json(await service.updateRider(req, req.params.id, req.body));
}));
ridersRouter.post("/:id/deactivate", audit("deactivate", "rider"), validate(z.object({ params: idParams })), asyncHandler(async (req, res) => {
  res.json(await service.setRiderStatus(req, req.params.id, "inactive"));
}));
ridersRouter.post("/:id/activate", audit("activate", "rider"), validate(z.object({ params: idParams })), asyncHandler(async (req, res) => {
  res.json(await service.setRiderStatus(req, req.params.id, "active"));
}));
ridersRouter.get("/:id/cash", validate(z.object({ params: idParams })), asyncHandler(async (req, res) => {
  res.json(await service.riderCash(req, req.params.id));
}));
ridersRouter.post(
  "/:id/cash/deposits",
  audit("cash_deposit", "rider"),
  validate(z.object({ params: idParams, body: z.object({ amount: z.number().positive().max(10_000_000), note: z.string().max(300).optional() }).strict() })),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.addDeposit(req, req.params.id, req.body));
  })
);

/* ------------------------------------------------------------------ seller: fleet board */

export const fleetRouter = Router();
fleetRouter.use(authenticate, resolveTenant, requireTenant, authorizeAny("riders.manage", "orders.update"));

fleetRouter.get("/board", validate(z.object({ query: z.object({ date: day.optional() }).passthrough() })), asyncHandler(async (req, res) => {
  res.json(await service.board(req));
}));
fleetRouter.post("/auto-assign", audit("auto_assign", "delivery_task"), validate(z.object({ body: z.object({ date: day.optional() }).strict() })), asyncHandler(async (req, res) => {
  res.json(await service.autoAssign(req, req.body));
}));
fleetRouter.get("/cash", asyncHandler(async (req, res) => {
  res.json(await service.cashOverview(req));
}));
fleetRouter.get("/tasks/:id", validate(z.object({ params: idParams })), asyncHandler(async (req, res) => {
  res.json(await service.getTask(req, req.params.id));
}));
fleetRouter.post("/tasks/:id/assign", audit("assign", "delivery_task"), validate(z.object({ params: idParams, body: z.object({ riderId: objectId }).strict() })), asyncHandler(async (req, res) => {
  res.json(await service.assignTask(req, req.params.id, req.body));
}));
fleetRouter.post("/tasks/:id/unassign", audit("unassign", "delivery_task"), validate(z.object({ params: idParams })), asyncHandler(async (req, res) => {
  res.json(await service.unassignTask(req, req.params.id));
}));
fleetRouter.post(
  "/tasks/:id/reschedule",
  audit("reschedule", "delivery_task"),
  validate(z.object({ params: idParams, body: z.object({ date: day, note: z.string().max(300).optional() }).strict() })),
  asyncHandler(async (req, res) => {
    res.json(await service.rescheduleTask(req, req.params.id, req.body));
  })
);
fleetRouter.post(
  "/tasks/:id/cancel",
  audit("cancel", "delivery_task"),
  validate(z.object({ params: idParams, body: z.object({ note: z.string().max(300).optional() }).strict() })),
  asyncHandler(async (req, res) => {
    res.json(await service.cancelTask(req, req.params.id, req.body));
  })
);

/* ------------------------------------------------------------------ rider app */

export const riderAppRouter = Router();
riderAppRouter.use(authenticate, authorize("rider.app"));

riderAppRouter.get("/me", asyncHandler(async (req, res) => {
  res.json(await service.riderMe(req));
}));
riderAppRouter.get("/cash", asyncHandler(async (req, res) => {
  res.json(await service.riderCashMine(req));
}));
riderAppRouter.get(
  "/tasks",
  validate(z.object({ query: z.object({ scope: z.enum(["today", "open", "done"]).optional() }).passthrough() })),
  asyncHandler(async (req, res) => {
    res.json(await service.riderTasks(req));
  })
);
riderAppRouter.get("/tasks/:id", validate(z.object({ params: idParams })), asyncHandler(async (req, res) => {
  res.json(await service.riderTask(req, req.params.id));
}));
const empty = z.object({}).strict();
riderAppRouter.post("/tasks/:id/accept", validate(z.object({ params: idParams, body: empty })), asyncHandler(async (req, res) => {
  res.json(await service.acceptTask(req, req.params.id));
}));
riderAppRouter.post(
  "/tasks/:id/reject",
  validate(z.object({ params: idParams, body: z.object({ reason: z.string().trim().max(300).optional() }).strict() })),
  asyncHandler(async (req, res) => {
    res.json(await service.rejectTask(req, req.params.id, req.body));
  })
);
riderAppRouter.post("/tasks/:id/pickup", validate(z.object({ params: idParams, body: empty })), asyncHandler(async (req, res) => {
  res.json(await service.pickupTask(req, req.params.id));
}));
riderAppRouter.post("/tasks/:id/start", validate(z.object({ params: idParams, body: empty })), asyncHandler(async (req, res) => {
  res.json(await service.startTask(req, req.params.id));
}));
riderAppRouter.post("/tasks/:id/resend-otp", validate(z.object({ params: idParams, body: empty })), asyncHandler(async (req, res) => {
  res.json(await service.resendOtp(req, req.params.id));
}));
riderAppRouter.post(
  "/tasks/:id/deliver",
  audit("deliver", "delivery_task"),
  validate(
    z.object({
      params: idParams,
      body: z
        .object({
          otp: z.string().trim().min(1).max(10),
          photoFileId: objectId.nullable().optional(),
          cod: z.object({ method: z.enum(["cash", "upi_qr"]) }).strict().nullable().optional(),
        })
        .strict(),
    })
  ),
  asyncHandler(async (req, res) => {
    res.json(await service.deliverTask(req, req.params.id, req.body));
  })
);
riderAppRouter.post("/tasks/:id/cod/qr", validate(z.object({ params: idParams, body: empty })), asyncHandler(async (req, res) => {
  res.json(await service.codQr(req, req.params.id));
}));
riderAppRouter.get("/tasks/:id/cod/qr", validate(z.object({ params: idParams })), asyncHandler(async (req, res) => {
  res.json(await service.codQrStatus(req, req.params.id));
}));
riderAppRouter.post(
  "/tasks/:id/fail",
  audit("fail", "delivery_task"),
  validate(
    z.object({
      params: idParams,
      body: z
        .object({ reason: z.enum(DELIVERY_FAIL_REASONS), note: z.string().max(500).optional(), photoFileId: objectId.nullable().optional() })
        .strict(),
    })
  ),
  asyncHandler(async (req, res) => {
    res.json(await service.failTask(req, req.params.id, req.body));
  })
);
riderAppRouter.post(
  "/tasks/:id/pickup-return",
  audit("pickup_return", "delivery_task"),
  validate(
    z.object({
      params: idParams,
      body: z
        .object({
          itemCheck: z
            .array(
              z
                .object({
                  lineId: objectId,
                  okQty: z.number().int().min(0).optional(),
                  damagedQty: z.number().int().min(0).optional(),
                  note: z.string().max(300).optional(),
                })
                .strict()
            )
            .max(200)
            .optional(),
          photos: z.array(objectId).max(10).optional(),
        })
        .strict(),
    })
  ),
  asyncHandler(async (req, res) => {
    res.json(await service.pickupReturn(req, req.params.id, req.body));
  })
);
riderAppRouter.post(
  "/tasks/:id/return-to-store",
  audit("return_to_store", "delivery_task"),
  validate(z.object({ params: idParams, body: z.object({ note: z.string().max(300).optional() }).strict() })),
  asyncHandler(async (req, res) => {
    res.json(await service.returnToStore(req, req.params.id, req.body));
  })
);
