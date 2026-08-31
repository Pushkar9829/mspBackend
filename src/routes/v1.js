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
import settingsRoutes from "../modules/settings/routes.js";

const v1 = Router();

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
v1.use("/settings", settingsRoutes);

export default v1;
