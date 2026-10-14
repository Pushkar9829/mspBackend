import { Router } from "express";
import authRoutes from "../modules/auth/routes.js";
import tenantRoutes from "../modules/tenants/routes.js";
import userRoutes from "../modules/users/routes.js";
import { roleRouter, permissionRouter } from "../modules/rbac/routes.js";
import auditRoutes from "../modules/audit/routes.js";
import {
  categoryRouter,
  brandRouter,
  productRouter,
  variantRouter,
  mediaRouter,
} from "../modules/catalog/routes.js";
import { pricingRouter, offerRouter, couponRouter } from "../modules/pricing/routes.js";
import { warehouseRouter, inventoryRouter } from "../modules/inventory/routes.js";
import { cartRouter, checkoutRouter } from "../modules/checkout/routes.js";
import orderRoutes from "../modules/orders/routes.js";
import locationRoutes from "../modules/location/routes.js";
import addressRoutes from "../modules/location/address.routes.js";
import chatRoutes from "../modules/chat/routes.js";
import notificationRoutes from "../modules/notifications/routes.js";
import { cmsPublicRouter, cmsAdminRouter } from "../modules/cms/routes.js";
import reportRoutes from "../modules/reports/routes.js";
import analyticsRoutes from "../modules/analytics/routes.js";
import settingsRoutes, { settingsPublicRouter } from "../modules/settings/routes.js";
import searchRoutes from "../modules/search/routes.js";
import ledgerRoutes from "../modules/ledger/routes.js";
import wishlistRoutes from "../modules/wishlist/routes.js";
import shippingRoutes from "../modules/shipping/routes.js";
import sellerApplicationRoutes from "../modules/sellerApplications/routes.js";
import termsRoutes from "../modules/terms/routes.js";
import billingRoutes, { publicPlansRouter, adminPlansRouter, adminSubscriptionsRouter } from "../modules/billing/routes.js";
import {
  adminTaxRouter,
  adminReconciliationRouter,
  adminCodRemittanceRouter,
  adminStatementRouter,
  sellerTaxRouter,
} from "../modules/payouts/taxRoutes.js";
import { sellerPayoutRouter, adminPayoutRouter } from "../modules/payouts/routes.js";
import { otpAuthRouter, ridersRouter, fleetRouter, riderAppRouter } from "../modules/fleet/routes.js";
import { disputeRouter, adminDisputeRouter } from "../modules/disputes/routes.js";
import devicesRoutes from "../modules/notifications/devices.routes.js";
import { sellerScorecardRouter, adminScorecardRouter } from "../modules/scorecard/routes.js";

const v1 = Router();

// Phase 5: rider mobile + OTP login (/auth/otp/request, /auth/otp/verify).
v1.use("/auth", otpAuthRouter);
v1.use("/auth", authRoutes);
v1.use("/tenants", tenantRoutes);
v1.use("/users", userRoutes);
v1.use("/roles", roleRouter);
v1.use("/permissions", permissionRouter);
v1.use("/audit", auditRoutes);
v1.use("/categories", categoryRouter);
v1.use("/brands", brandRouter);
v1.use("/products", productRouter);
v1.use("/variants", variantRouter);
v1.use("/media", mediaRouter);
v1.use("/pricing", pricingRouter);
v1.use("/offers", offerRouter);
v1.use("/coupons", couponRouter);
v1.use("/warehouses", warehouseRouter);
v1.use("/inventory", inventoryRouter);
v1.use("/cart", cartRouter);
v1.use("/checkout", checkoutRouter);
v1.use("/orders", orderRoutes);
v1.use("/location", locationRoutes);
v1.use("/addresses", addressRoutes);
v1.use("/chat", chatRoutes);
v1.use("/notifications", notificationRoutes);
v1.use("/cms", cmsPublicRouter);
v1.use("/cms/admin", cmsAdminRouter);
v1.use("/reports", reportRoutes);
v1.use("/analytics", analyticsRoutes);
v1.use("/settings", settingsPublicRouter);
v1.use("/settings", settingsRoutes);
v1.use("/search", searchRoutes);
v1.use("/ledger", ledgerRoutes);
v1.use("/wishlist", wishlistRoutes);
v1.use("/shipping", shippingRoutes);
v1.use("/seller-applications", sellerApplicationRoutes);
v1.use("/terms", termsRoutes);
v1.use("/plans", publicPlansRouter);
v1.use("/admin/plans", adminPlansRouter);
v1.use("/admin/subscriptions", adminSubscriptionsRouter);
v1.use("/billing", billingRoutes);
// Phase 4 (p4-tax): tax reports, reconciliation, COD remittances, seller statements. The
// statement routers share the /payouts and /admin/payouts prefixes with p4-payouts' routers
// (non-overlapping paths; unmatched requests fall through).
v1.use("/admin/tax", adminTaxRouter);
v1.use("/admin/reconciliation", adminReconciliationRouter);
v1.use("/admin/cod-remittances", adminCodRemittanceRouter);
v1.use("/admin/payouts", adminStatementRouter);
v1.use("/payouts", sellerTaxRouter);
// Phase 4 (p4-payouts): seller balance / ledger / payouts and admin payout management.
v1.use("/admin/payouts", adminPayoutRouter);
v1.use("/payouts", sellerPayoutRouter);
// Phase 5 (p5-backend): own delivery fleet — riders (seller), delivery board (seller), rider app.
v1.use("/riders", ridersRouter);
v1.use("/fleet", fleetRouter);
v1.use("/rider", riderAppRouter);
// Phase 6 (p6-backend): disputes, mobile push devices, seller scorecard.
v1.use("/disputes", disputeRouter);
v1.use("/admin/disputes", adminDisputeRouter);
v1.use("/devices", devicesRoutes);
v1.use("/scorecard", sellerScorecardRouter);
v1.use("/admin/scorecards", adminScorecardRouter);

export default v1;
