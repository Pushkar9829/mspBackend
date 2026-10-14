import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize, authorizeAny, hasPermission } from "../../middleware/authorize.js";
import { resolveTenant, requireStaff, requireTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { logger } from "../../utils/logger.js";
import * as svc from "./service.js";
import * as rzp from "./razorpayBilling.js";
import { renderSubscriptionInvoicePdf } from "./pdf.js";
import {
  createPlanSchema,
  updatePlanSchema,
  idParamSchema,
  listPlansSchema,
  choosePlanSchema,
  payInvoiceSchema,
  verifyInvoiceSchema,
  verifyAutopaySchema,
  listInvoicesSchema,
  listSubscriptionsSchema,
  adminPlanSchema,
  billingModeSchema,
  extendGraceSchema,
  compSchema,
  discountSchema,
  generateInvoiceSchema,
  markPaidSchema,
  voidInvoiceSchema,
  invoiceParamSchema,
} from "./validators.js";

/**
 * Seller subscription billing (p3-billing).
 *   GET  /api/v1/plans                              public active plans (for /sell)
 *   /api/v1/admin/plans                             plan CRUD (billing.manage)
 *   /api/v1/admin/subscriptions                     subscriptions + platform invoices (billing.manage)
 *   /api/v1/billing/me...                           the store's own subscription (store staff)
 *   /api/v1/billing/me/entitlements                 p3-limits (entitlements.routes.js, mounted here)
 */

function sendPdf(res, inv) {
  const name = `${String(inv.number || inv._id).replace(/[^A-Za-z0-9-]+/g, "_")}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${name}"`);
  res.send(renderSubscriptionInvoicePdf(inv));
}

/* ------------------------------------------------------------------ public */

export const publicPlansRouter = Router();
publicPlansRouter.get("/", asyncHandler(async (_req, res) => res.json(await svc.listPublicPlans())));

/* ------------------------------------------------------------------ admin: plans */

export const adminPlansRouter = Router();
adminPlansRouter.use(authenticate, authorize("billing.manage"));
adminPlansRouter.get("/", validate(listPlansSchema), asyncHandler(async (req, res) => res.json(await svc.listPlans(req.query))));
adminPlansRouter.post(
  "/",
  audit("create", "plan"),
  validate(createPlanSchema),
  asyncHandler(async (req, res) => res.status(201).json(await svc.createPlan(req, req.body)))
);
adminPlansRouter.get("/:id", validate(idParamSchema), asyncHandler(async (req, res) => res.json(await svc.getPlan(req.params.id))));
adminPlansRouter.patch(
  "/:id",
  audit("update", "plan"),
  validate(updatePlanSchema),
  asyncHandler(async (req, res) => res.json(await svc.updatePlan(req, req.params.id, req.body)))
);
adminPlansRouter.post(
  "/:id/archive",
  audit("archive", "plan"),
  validate(idParamSchema),
  asyncHandler(async (req, res) => res.json(await svc.archivePlan(req, req.params.id)))
);
adminPlansRouter.delete(
  "/:id",
  audit("archive", "plan"),
  validate(idParamSchema),
  asyncHandler(async (req, res) => res.json(await svc.archivePlan(req, req.params.id)))
);

/* ------------------------------------------------------------------ admin: subscriptions */

export const adminSubscriptionsRouter = Router();
adminSubscriptionsRouter.use(authenticate, authorize("billing.manage"));

adminSubscriptionsRouter.get(
  "/invoices",
  validate(listInvoicesSchema),
  asyncHandler(async (req, res) => res.json(await svc.listInvoices(req.query.tenantId ? { tenantId: req.query.tenantId } : {}, req.query)))
);
adminSubscriptionsRouter.get(
  "/invoices/:invoiceId",
  validate(invoiceParamSchema),
  asyncHandler(async (req, res) => res.json(svc.presentInvoice(await svc.getInvoice(req.params.invoiceId), { admin: true })))
);
adminSubscriptionsRouter.get(
  "/invoices/:invoiceId/pdf",
  validate(invoiceParamSchema),
  asyncHandler(async (req, res) => sendPdf(res, await svc.getInvoice(req.params.invoiceId)))
);
adminSubscriptionsRouter.post(
  "/invoices/:invoiceId/mark-paid",
  audit("mark_paid", "subscription_invoice"),
  validate(markPaidSchema),
  asyncHandler(async (req, res) => res.json(await svc.adminMarkPaid(req, req.params.invoiceId, req.body)))
);
adminSubscriptionsRouter.post(
  "/invoices/:invoiceId/void",
  audit("void", "subscription_invoice"),
  validate(voidInvoiceSchema),
  asyncHandler(async (req, res) => res.json(await svc.adminVoidInvoice(req, req.params.invoiceId, req.body)))
);

adminSubscriptionsRouter.get("/", validate(listSubscriptionsSchema), asyncHandler(async (req, res) => res.json(await svc.listSubscriptions(req.query))));
/** `:id` = subscription id or store (tenant) id. */
adminSubscriptionsRouter.get("/:id", validate(idParamSchema), asyncHandler(async (req, res) => res.json(await svc.getSubscriptionDetail(req.params.id))));
adminSubscriptionsRouter.get(
  "/:id/invoices",
  validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const detail = await svc.getSubscriptionDetail(req.params.id);
    res.json(await svc.listInvoices({ tenantId: detail.subscription.tenantId }, req.query));
  })
);
adminSubscriptionsRouter.post(
  "/:id/plan",
  audit("change_plan", "subscription"),
  validate(adminPlanSchema),
  asyncHandler(async (req, res) => res.json(await svc.adminChangePlan(req, req.params.id, req.body)))
);
adminSubscriptionsRouter.post(
  "/:id/billing-mode",
  audit("billing_mode", "subscription"),
  validate(billingModeSchema),
  asyncHandler(async (req, res) => res.json(await svc.setBillingMode(req, req.params.id, req.body)))
);
adminSubscriptionsRouter.post(
  "/:id/extend-grace",
  audit("extend_grace", "subscription"),
  validate(extendGraceSchema),
  asyncHandler(async (req, res) => res.json(await svc.extendGrace(req, req.params.id, req.body)))
);
adminSubscriptionsRouter.post(
  "/:id/comp",
  audit("comp", "subscription"),
  validate(compSchema),
  asyncHandler(async (req, res) => res.json(await svc.compPeriod(req, req.params.id, req.body)))
);
adminSubscriptionsRouter.post(
  "/:id/discount",
  audit("discount", "subscription"),
  validate(discountSchema),
  asyncHandler(async (req, res) => res.json(await svc.setDiscount(req, req.params.id, req.body)))
);
adminSubscriptionsRouter.post(
  "/:id/invoices",
  audit("generate_invoice", "subscription"),
  validate(generateInvoiceSchema),
  asyncHandler(async (req, res) => res.status(201).json(await svc.adminGenerateInvoice(req, req.params.id, req.body)))
);

/* ------------------------------------------------------------------ seller (store staff) */

export const billingRouter = Router();
billingRouter.use(authenticate, resolveTenant, requireStaff, requireTenant);

const canView = authorizeAny("settings.view", "settings.edit");
const canManage = authorize("settings.edit");

// Every staff member gets the status (for the overdue / paused banners); prices and invoice
// details need settings access.
billingRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const full = hasPermission(req, "settings.view") || hasPermission(req, "settings.edit");
    res.json(await svc.getMyBilling(req.tenantId, { summary: !full }));
  })
);
billingRouter.get(
  "/me/invoices",
  canView,
  validate(listInvoicesSchema),
  asyncHandler(async (req, res) => res.json(await svc.listInvoices({ tenantId: req.tenantId }, req.query)))
);
billingRouter.get(
  "/me/invoices/:id",
  canView,
  validate(idParamSchema),
  asyncHandler(async (req, res) => res.json(svc.presentInvoice(await svc.getInvoice(req.params.id, { tenantId: req.tenantId }))))
);
billingRouter.get(
  "/me/invoices/:id/pdf",
  canView,
  validate(idParamSchema),
  asyncHandler(async (req, res) => sendPdf(res, await svc.getInvoice(req.params.id, { tenantId: req.tenantId })))
);
billingRouter.post(
  "/me/plan",
  canManage,
  audit("choose_plan", "subscription"),
  validate(choosePlanSchema),
  asyncHandler(async (req, res) => res.json(await svc.changePlan(req.tenantId, { ...req.body, by: req.user._id })))
);
billingRouter.post(
  "/me/autopay",
  canManage,
  audit("autopay_setup", "subscription"),
  asyncHandler(async (req, res) => res.json(await rzp.setupAutopay(req.tenantId, { by: req.user._id })))
);
billingRouter.post(
  "/me/autopay/verify",
  canManage,
  audit("autopay_verify", "subscription"),
  validate(verifyAutopaySchema),
  asyncHandler(async (req, res) => res.json(await rzp.verifyAutopay(req.tenantId, req.body, { by: req.user._id })))
);
billingRouter.post(
  "/me/autopay/cancel",
  canManage,
  audit("autopay_cancel", "subscription"),
  asyncHandler(async (req, res) => res.json(await rzp.cancelAutopay(req.tenantId, { by: req.user._id })))
);
billingRouter.post(
  "/me/invoices/:id/pay",
  canManage,
  validate(payInvoiceSchema),
  asyncHandler(async (req, res) => res.json(await rzp.createInvoicePayment(req.tenantId, req.params.id, req.body)))
);
billingRouter.post(
  "/me/invoices/:id/verify",
  canManage,
  audit("pay_invoice", "subscription_invoice"),
  validate(verifyInvoiceSchema),
  asyncHandler(async (req, res) => res.json(await rzp.verifyInvoicePayment(req.tenantId, req.params.id, req.body, { by: req.user._id })))
);

// GET /me/entitlements (p3-limits). Tolerates the file not existing yet.
try {
  const mod = await import("./entitlements.routes.js");
  const entitlementsRouter = mod.default || mod.entitlementsRouter || mod.router;
  if (entitlementsRouter) billingRouter.use(entitlementsRouter);
} catch (err) {
  if (err?.code !== "ERR_MODULE_NOT_FOUND" || !String(err?.message || "").includes("entitlements.routes")) throw err;
  logger.warn("billing: entitlements.routes.js not found, /billing/me/entitlements unavailable");
}

export default billingRouter;
