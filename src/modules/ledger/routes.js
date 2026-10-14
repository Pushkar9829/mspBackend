import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant, requireTenant, requireStaff } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";
import { assertFeature } from "../billing/entitlements.js";
import { mountRepaymentRoutes } from "../payouts/routes.js";

/**
 * Plan feature `creditTerms`: needed to ENABLE credit / purchase orders or set a credit limit above 0.
 * Switching terms off, setting the limit to 0, recording payments and adjustments stay available so a
 * downgraded store can wind existing credit down.
 */
async function creditTermsGate(req, _res, next) {
  try {
    const b = req.body || {};
    const enabling = b.creditEnabled === true || b.purchaseOrderEnabled === true || (b.creditLimit !== undefined && Number(b.creditLimit) > 0);
    if (enabling) await assertFeature(req.tenantId, "creditTerms", { req });
    next();
  } catch (err) {
    next(err);
  }
}

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const userParam = z.object({ userId: objectId });

const canView = authorizeAny("ledger.view", "ledger.manage");
const canManage = authorizeAny("ledger.manage");

const router = Router();
router.use(authenticate);

router.get(
  "/me",
  validate(
    z.object({
      query: z
        .object({
          tenantId: objectId.optional(),
          page: z.coerce.number().int().min(1).max(10000).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          before: z.string().trim().min(1).max(40).optional(),
        })
        .passthrough(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { page, limit, before } = req.query;
    res.json(await service.getLedgerForUser(req.user._id, req.query.tenantId || null, { page, limit, before }));
  })
);

// Buyer repays credit / PO dues online through the platform (p4-payouts): POST /me/:tenantId/pay(/verify).
mountRepaymentRoutes(router);

const seller = Router();
seller.use(resolveTenant, requireStaff, requireTenant);

seller.get("/", canView, asyncHandler(async (req, res) => {
  res.json(await service.listAccounts(req));
}));

seller.get("/:userId", canView, validate(z.object({ params: userParam })), asyncHandler(async (req, res) => {
  res.json(await service.getAccount(req, req.params.userId));
}));

seller.get("/:userId/statement", canView, validate(z.object({ params: userParam })), asyncHandler(async (req, res) => {
  res.json(await service.getStatement(req, req.params.userId));
}));

seller.put(
  "/:userId/terms",
  canManage,
  validate(
    z.object({
      params: userParam,
      body: z
        .object({
          creditEnabled: z.boolean().optional(),
          purchaseOrderEnabled: z.boolean().optional(),
          creditLimit: z.number().min(0).max(1e9).optional(),
          paymentDays: z.number().int().min(0).max(365).optional(),
        })
        .strict(),
    })
  ),
  audit("terms", "ledger"),
  creditTermsGate,
  asyncHandler(async (req, res) => {
    res.json(await service.setBuyerTerms(req, req.params.userId, req.body));
  })
);

seller.post(
  "/:userId/payments",
  canManage,
  validate(
    z.object({
      params: userParam,
      body: z
        .object({
          amount: z.number().positive().max(1e9),
          reference: z.string().max(120).optional(),
          note: z.string().max(500).optional(),
        })
        .strict(),
    })
  ),
  audit("payment", "ledger"),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.recordPayment(req, req.params.userId, req.body));
  })
);

seller.post(
  "/:userId/adjustments",
  canManage,
  validate(
    z.object({
      params: userParam,
      body: z
        .object({
          amount: z.number().refine((n) => n !== 0, "amount must not be 0").refine((n) => Math.abs(n) <= 1e9, "too large"),
          note: z.string().min(1).max(500),
        })
        .strict(),
    })
  ),
  audit("adjust", "ledger"),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.adjustBalance(req, req.params.userId, req.body));
  })
);

router.use("/accounts", seller);

export default router;
