import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize, authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import * as svc from "./service.js";

/**
 * Phase 6 disputes.
 *   /api/v1/disputes          buyer (own disputes) + store staff with returns.manage / orders.refund
 *   /api/v1/admin/disputes    platform, disputes.manage
 */

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const idParams = z.object({ id: objectId });
const fileIds = z.array(objectId).max(10).optional().default([]);
const listQuery = z
  .object({
    status: z.string().max(200).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sort: z.enum(["newest", "oldest", "respondBy", "updated"]).optional(),
    orderId: objectId.optional(),
  })
  .passthrough();

/** Buyers pass; store staff need returns.manage (or orders.refund, same as the return endpoints). */
function buyerOrStaff(req, res, next) {
  if (req.isBuyer && !req.isPlatformAdmin) return next();
  return authorizeAny("returns.manage", "orders.refund", "disputes.manage")(req, res, next);
}

function buyerOnly(req, _res, next) {
  if (req.isBuyer && !req.isPlatformAdmin) return next();
  return next(new AppError(403, "Only the buyer can do this", "FORBIDDEN"));
}

export const disputeRouter = Router();
disputeRouter.use(authenticate);
disputeRouter.use((req, res, next) => (req.isBuyer && !req.isPlatformAdmin ? next() : resolveTenant(req, res, next)));
disputeRouter.use(buyerOrStaff);

disputeRouter.get("/", validate(z.object({ query: listQuery })), asyncHandler(async (req, res) => res.json(await svc.listMine(req))));
disputeRouter.post(
  "/",
  buyerOnly,
  validate(
    z.object({
      body: z
        .object({
          orderId: objectId,
          returnId: objectId,
          message: z.string().trim().min(5).max(4000),
          fileIds,
        })
        .strict(),
    })
  ),
  audit("create", "dispute"),
  asyncHandler(async (req, res) => res.status(201).json(await svc.openDispute(req, req.body)))
);
disputeRouter.get("/:id", validate(z.object({ params: idParams })), asyncHandler(async (req, res) => res.json(await svc.getOne(req, req.params.id))));
disputeRouter.post(
  "/:id/messages",
  validate(z.object({ params: idParams, body: z.object({ text: z.string().max(4000).optional().default(""), fileIds }).strict() })),
  audit("message", "dispute"),
  asyncHandler(async (req, res) => res.json(await svc.addMessage(req, req.params.id, req.body)))
);
disputeRouter.post(
  "/:id/withdraw",
  buyerOnly,
  validate(z.object({ params: idParams, body: z.object({ note: z.string().max(500).optional() }).strict().optional().default({}) })),
  audit("withdraw", "dispute"),
  asyncHandler(async (req, res) => res.json(await svc.withdraw(req, req.params.id, req.body || {})))
);
disputeRouter.get(
  "/:id/files/:fileId/link",
  validate(z.object({ params: idParams.extend({ fileId: objectId }) })),
  asyncHandler(async (req, res) => res.json(await svc.fileLink(req, req.params.id, req.params.fileId)))
);

export const adminDisputeRouter = Router();
adminDisputeRouter.use(authenticate, authorize("disputes.manage"));
adminDisputeRouter.use((req, _res, next) => (req.isPlatformAdmin ? next() : next(new AppError(403, "Platform only", "FORBIDDEN"))));
adminDisputeRouter.get(
  "/",
  validate(
    z.object({
      query: listQuery.extend({
        tenantId: objectId.optional(),
        age: z.enum(["24h", "3d", "7d"]).optional(),
        minAgeHours: z.coerce.number().int().min(0).max(24 * 365).optional(),
        q: z.string().max(60).optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => res.json(await svc.adminList(req.query)))
);
adminDisputeRouter.get("/:id", validate(z.object({ params: idParams })), asyncHandler(async (req, res) => res.json(await svc.getOne(req, req.params.id))));
adminDisputeRouter.post(
  "/:id/decide",
  validate(
    z.object({
      params: idParams,
      body: z
        .object({
          action: z.enum(["refund", "reopen", "reject"]),
          amount: z.number().finite().positive().max(10_000_000).optional(),
          reason: z.string().trim().min(3).max(2000),
        })
        .strict(),
    })
  ),
  audit("decide", "dispute"),
  asyncHandler(async (req, res) => res.json(await svc.decide(req, req.params.id, req.body)))
);
adminDisputeRouter.post(
  "/:id/request-info",
  validate(z.object({ params: idParams, body: z.object({ from: z.enum(["buyer", "seller"]), message: z.string().trim().min(3).max(4000) }).strict() })),
  audit("request_info", "dispute"),
  asyncHandler(async (req, res) => res.json(await svc.requestInfo(req, req.params.id, req.body)))
);
adminDisputeRouter.post(
  "/:id/messages",
  validate(z.object({ params: idParams, body: z.object({ text: z.string().max(4000).optional().default(""), fileIds }).strict() })),
  audit("message", "dispute"),
  asyncHandler(async (req, res) => res.json(await svc.addMessage(req, req.params.id, req.body)))
);
adminDisputeRouter.get(
  "/:id/files/:fileId/link",
  validate(z.object({ params: idParams.extend({ fileId: objectId }) })),
  asyncHandler(async (req, res) => res.json(await svc.fileLink(req, req.params.id, req.params.fileId)))
);
