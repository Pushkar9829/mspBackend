import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant, requireStaff, requireTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { storeScorecard, allScorecards, thresholds } from "./service.js";

/**
 * Phase 6 seller scorecard.
 *   GET /api/v1/scorecard/me?days=30|90                 store staff (orders.view | reports.view | returns.manage)
 *   GET /api/v1/admin/scorecards?days&sort&order&status&q&page&limit   platform (tenants.view)
 *   GET /api/v1/admin/scorecards/:tenantId?days=30|90   platform -> { d30, d90 } when days omitted
 */

const days = z.coerce.number().int().refine((n) => n === 30 || n === 90, "days must be 30 or 90");

export const sellerScorecardRouter = Router();
sellerScorecardRouter.use(authenticate, resolveTenant, requireStaff, requireTenant, authorizeAny("orders.view", "reports.view", "returns.manage"));
sellerScorecardRouter.get(
  "/me",
  validate(z.object({ query: z.object({ days: days.optional() }).passthrough() })),
  asyncHandler(async (req, res) => res.json(await storeScorecard(req.tenantId, { days: req.query.days || 30 })))
);

export const adminScorecardRouter = Router();
adminScorecardRouter.use(authenticate, authorizeAny("tenants.view", "disputes.manage"));
adminScorecardRouter.use((req, _res, next) => (req.isPlatformAdmin ? next() : next(new AppError(403, "Platform only", "FORBIDDEN"))));
adminScorecardRouter.get(
  "/",
  validate(
    z.object({
      query: z
        .object({
          days: days.optional(),
          sort: z.enum(["cancelRate", "lateShipRate", "returnRate", "disputeRate", "disputesLost", "orders", "name", "overall"]).optional(),
          order: z.enum(["asc", "desc"]).optional(),
          status: z.enum(["good", "warning", "bad"]).optional(),
          q: z.string().max(60).optional(),
          page: z.coerce.number().int().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .passthrough(),
    })
  ),
  asyncHandler(async (req, res) => res.json(await allScorecards(req.query)))
);
adminScorecardRouter.get(
  "/:tenantId",
  validate(z.object({ params: z.object({ tenantId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid id") }), query: z.object({ days: days.optional() }).passthrough() })),
  asyncHandler(async (req, res) => {
    if (req.query.days) return res.json(await storeScorecard(req.params.tenantId, { days: req.query.days }));
    const [d30, d90, limits] = await Promise.all([
      storeScorecard(req.params.tenantId, { days: 30 }),
      storeScorecard(req.params.tenantId, { days: 90 }),
      thresholds(),
    ]);
    res.json({ tenantId: req.params.tenantId, thresholds: limits, d30, d90 });
  })
);
