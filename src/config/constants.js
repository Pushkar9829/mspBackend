export const TENANT_STATUSES = [
  "active",
  "suspended",
  "trial",
  "pending",
  "archived",
];

export const USER_STATUSES = ["active", "pending", "suspended", "locked"];

export const PRODUCT_STATUSES = [
  "draft",
  "pending_review",
  "published",
  "scheduled",
  "archived",
];

export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "ready_to_ship",
  "shipped",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "return_requested",
  "refunded",
];

export const PAYMENT_METHODS = ["upi", "card", "netbanking", "cod", "purchase_order", "credit_terms"];

export const PAYMENT_STATUSES = [
  "unpaid",
  "pending",
  "paid",
  "failed",
  "refunded",
];

export const CONVERSATION_TYPES = [
  "general_support",
  "order_support",
  "product_inquiry",
  "payment",
  "delivery",
  "returns",
];

export const CONVERSATION_STATUSES = [
  "open",
  "unassigned",
  "assigned",
  "waiting_customer",
  "resolved",
  "closed",
];

export const CMS_STATUSES = ["draft", "review", "published", "unpublished"];

export const INVENTORY_REASONS = [
  "inward",
  "adjustment",
  "transfer_out",
  "transfer_in",
  "reserve",
  "release",
  "commit",
  "damage",
  "return",
];

export const SYSTEM_ROLES = {
  SUPER_ADMIN: "super_admin",
  TENANT_ADMIN: "tenant_admin",
  SUPPORT_AGENT: "support_agent",
  BUYER: "buyer",
};

export const PERMISSIONS = [
  "tenants.view",
  "tenants.create",
  "tenants.edit",
  "tenants.suspend",
  "users.view",
  "users.create",
  "users.edit",
  "users.delete",
  "users.activate",
  "roles.view",
  "roles.create",
  "roles.edit",
  "roles.delete",
  "permissions.assign",
  "products.view",
  "products.create",
  "products.edit",
  "products.delete",
  "products.publish",
  "categories.view",
  "categories.create",
  "categories.edit",
  "categories.delete",
  "brands.view",
  "brands.create",
  "brands.edit",
  "brands.delete",
  "inventory.view",
  "inventory.adjust",
  "inventory.transfer",
  "inventory.publish",
  "warehouses.view",
  "warehouses.create",
  "warehouses.edit",
  "pricing.view",
  "pricing.create",
  "pricing.edit",
  "pricing.approve",
  "offers.create",
  "offers.edit",
  "coupons.create",
  "coupons.disable",
  "orders.view",
  "orders.create",
  "orders.update",
  "orders.cancel",
  "orders.refund",
  "cms.view",
  "cms.create",
  "cms.edit",
  "cms.publish",
  "chat.view",
  "chat.reply",
  "chat.assign",
  "chat.close",
  "reports.view",
  "reports.export",
  "analytics.view",
  "notifications.create",
  "notifications.send",
  "notifications.manage",
  "audit.view",
];

export const TENANT_ADMIN_PERMISSIONS = PERMISSIONS.filter(
  (p) => !p.startsWith("tenants.")
);

export const SUPPORT_AGENT_PERMISSIONS = [
  "chat.view",
  "chat.reply",
  "chat.assign",
  "chat.close",
  "orders.view",
  "users.view",
  "products.view",
];

export const BUYER_PERMISSIONS = [
  "products.view",
  "orders.view",
  "orders.create",
  "orders.cancel",
  "chat.view",
  "chat.reply",
];

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MINUTES = 15;
export const CART_RESERVATION_MINUTES = 15;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "video/mp4",
];
