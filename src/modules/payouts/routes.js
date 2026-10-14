import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize, authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant, requireStaff, requireTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as svc from "./service.js";
import * as repay from "./repayments.js";
import {
  ledgerQuerySchema,
  payoutListSchema,
  idParamSchema,
  tenantParamSchema,
  sellerDetailSchema,
  sellersListSchema,
  markPaidSchema,
  cancelSchema,
  holdSchema,
  adjustmentSchema,
  repaySchema,
  repayVerifySchema,
} from "./validators.js";

/**
 * Seller payouts (p4-payouts).
 *   /api/v1/payouts/me...            store staff with payouts.view (platform admin via X-Tenant-Id)
 *   /api/v1/admin/payouts...         platform payouts.manage
 *   /api/v1/ledger/me/:tenantId/pay  buyer repays credit online (mounted from ledger routes)
 */

/* ------------------------------------------------------------------ seller */

export const sellerPayoutRouter = Router();
sellerPayoutRouter.use(authenticate, resolveTenant, requireStaff, requireTenant, authorizeAny("payouts.view"));
sellerPayoutRouter.get("/me", asyncHandler(async (req, res) => res.json(await svc.sellerOverview(req.tenantId))));
sellerPayoutRouter.get("/me/ledger", validate(ledgerQuerySchema), asyncHandler(async (req, res) => res.json(await svc.listLedger(req.tenantId, req.query))));
sellerPayoutRouter.get(
  "/me/payouts",
  validate(payoutListSchema),
  asyncHandler(async (req, res) => res.json(await svc.listPayouts({ tenantId: req.tenantId }, { ...req.query, tenantId: undefined })))
);
sellerPayoutRouter.get(
  "/me/payouts/:id",
  validate(idParamSchema),
  asyncHandler(async (req, res) => res.json(await svc.getPayout(req.params.id, { tenantId: req.tenantId })))
);

/* ------------------------------------------------------------------ admin */

export const adminPayoutRouter = Router();
adminPayoutRouter.use(authenticate, authorize("payouts.manage"));
adminPayoutRouter.get("/", validate(payoutListSchema), asyncHandler(async (req, res) => res.json(await svc.listPayouts({}, req.query, { admin: true }))));
adminPayoutRouter.get("/sellers", validate(sellersListSchema), asyncHandler(async (req, res) => res.json(await svc.adminSellers(req.query))));
adminPayoutRouter.get(
  "/sellers/:tenantId",
  validate(sellerDetailSchema),
  asyncHandler(async (req, res) => res.json(await svc.adminSellerDetail(req.params.tenantId, req.query)))
);
adminPayoutRouter.post(
  "/sellers/:tenantId/hold",
  audit("payout_hold", "tenant"),
  validate(holdSchema),
  asyncHandler(async (req, res) => res.json(await svc.setHold(req.params.tenantId, req.body, { by: req.user._id })))
);
adminPayoutRouter.post(
  "/sellers/:tenantId/release-hold",
  audit("payout_release_hold", "tenant"),
  validate(tenantParamSchema),
  asyncHandler(async (req, res) => res.json(await svc.releaseHold(req.params.tenantId)))
);
adminPayoutRouter.post(
  "/sellers/:tenantId/run",
  audit("payout_run", "tenant"),
  validate(tenantParamSchema),
  asyncHandler(async (req, res) => {
    const out = await svc.runPayoutForTenant(req.params.tenantId, { by: req.user._id, explicit: true });
    res.json(out.payout ? { payout: await svc.getPayout(out.payout._id, { admin: true }) } : { payout: null, skipped: out.skipped, availablePaise: out.availablePaise ?? null });
  })
);
adminPayoutRouter.post(
  "/sellers/:tenantId/adjustment",
  audit("payout_adjustment", "tenant"),
  validate(adjustmentSchema),
  asyncHandler(async (req, res) => res.status(201).json(await svc.addAdjustment(req.params.tenantId, req.body, { by: req.user._id })))
);
adminPayoutRouter.post(
  "/sellers/:tenantId/linked-account",
  audit("payout_linked_account", "tenant"),
  validate(tenantParamSchema),
  asyncHandler(async (req, res) => res.json(await svc.adminLinkedAccount(req.params.tenantId)))
);
// POST so the audit log records every reveal of a full account number.
adminPayoutRouter.post(
  "/:id/bank/reveal",
  audit("payout_bank_reveal", "payout"),
  validate(idParamSchema),
  asyncHandler(async (req, res) => res.json(await svc.payoutBankDetails(req.params.id)))
);
adminPayoutRouter.get("/:id", validate(idParamSchema), asyncHandler(async (req, res) => res.json(await svc.getPayout(req.params.id, { admin: true }))));
adminPayoutRouter.post(
  "/:id/mark-paid",
  audit("payout_mark_paid", "payout"),
  validate(markPaidSchema),
  asyncHandler(async (req, res) => res.json(await svc.markPayoutPaid(req.params.id, req.body, { by: req.user._id })))
);
adminPayoutRouter.post(
  "/:id/retry",
  audit("payout_retry", "payout"),
  validate(idParamSchema),
  asyncHandler(async (req, res) => res.json(await svc.retryPayout(req.params.id, { by: req.user._id })))
);
adminPayoutRouter.post(
  "/:id/cancel",
  audit("payout_cancel", "payout"),
  validate(cancelSchema),
  asyncHandler(async (req, res) => res.json(await svc.cancelPayout(req.params.id, req.body, { by: req.user._id })))
);

/* ------------------------------------------------------------------ buyer credit repayment */

/** Mounted on the ledger router (after authenticate): /me/:tenantId/pay, /me/:tenantId/pay/verify. */
export function mountRepaymentRoutes(router) {
  router.post(
    "/me/:tenantId/pay",
    validate(repaySchema),
    asyncHandler(async (req, res) => res.status(201).json(await repay.createRepaymentOrder(req.user, req.params.tenantId, req.body)))
  );
  router.post(
    "/me/:tenantId/pay/verify",
    validate(repayVerifySchema),
    asyncHandler(async (req, res) => res.json(await repay.verifyRepayment(req.user, req.params.tenantId, req.body)))
  );
}
