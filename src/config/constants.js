export const TENANT_STATUSES = [
  "active",
  "suspended",
  "trial",
  "pending",
  "archived",
];

// "locked" is legacy (old lockout flipped status); lockout is now a temporary `lockedUntil` only.
// "deleted" = self-deleted / anonymised account.
export const USER_STATUSES = ["active", "pending", "suspended", "locked", "deleted"];

/** Business timezone for day boundaries, financial year, reports. Import this, don't hard-code. */
export const BUSINESS_TZ = "Asia/Kolkata";

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
  "return_approved",
  "returned",
  "refunded",
];

export const PAYMENT_METHODS = ["upi", "card", "netbanking", "cod", "purchase_order", "credit_terms"];

export const FULFILLMENT_MODES = ["store_pickup", "delivery_partner"];

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
  "incoming",
  "consume",
  "restore",
  "set",
  "archive",
  "reown",
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
  "coupons.edit",
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
  "settings.view",
  "settings.edit",
  "audit.view",
  "ledger.view",
  "ledger.manage",
  "reviews.moderate",
  "media.upload",
  "returns.manage",
];

/**
 * Human-readable catalogue for every permission key: { group, label, description }.
 * Served by GET /permissions and written to the Permission collection on boot.
 */
export const PERMISSION_GROUPS = {
  tenants: "Stores (platform)",
  users: "Team & customers",
  roles: "Roles & permissions",
  permissions: "Roles & permissions",
  products: "Catalogue",
  categories: "Catalogue",
  brands: "Catalogue",
  media: "Catalogue",
  reviews: "Catalogue",
  inventory: "Inventory",
  warehouses: "Inventory",
  pricing: "Pricing & promotions",
  offers: "Pricing & promotions",
  coupons: "Pricing & promotions",
  orders: "Orders",
  returns: "Orders",
  ledger: "Finance",
  cms: "Content",
  chat: "Customer support",
  notifications: "Notifications",
  reports: "Reports & analytics",
  analytics: "Reports & analytics",
  settings: "Settings",
  audit: "Settings",
};

export const PERMISSION_META = {
  "tenants.view": ["View stores", "See every store on the platform, its profile and status."],
  "tenants.create": ["Create stores", "Onboard a new store and its first administrator."],
  "tenants.edit": ["Edit stores", "Change any store's profile, branding, tax and order rules."],
  "tenants.suspend": ["Suspend stores", "Suspend, archive or reactivate a store."],
  "users.view": ["View users", "See team members and the store's customers."],
  "users.create": ["Add team members", "Invite or create new user accounts."],
  "users.edit": ["Edit users", "Change a user's name, role or status and sign them out everywhere."],
  "users.delete": ["Deactivate users", "Suspend user accounts so they can no longer sign in."],
  "users.activate": ["Activate users", "Approve pending accounts and reactivate suspended ones."],
  "roles.view": ["View roles", "See roles and the permissions they grant."],
  "roles.create": ["Create roles", "Create custom roles for the store."],
  "roles.edit": ["Edit roles", "Rename custom roles and change their permissions."],
  "roles.delete": ["Delete roles", "Delete custom roles that nobody holds."],
  "permissions.assign": ["Assign permissions", "Grant permissions to roles (only permissions you hold yourself)."],
  "products.view": ["View products", "Browse products, variants and their details."],
  "products.create": ["Create products", "Add products and variants, import and export the catalogue."],
  "products.edit": ["Edit products", "Change product details, specifications, variants and images."],
  "products.delete": ["Delete products", "Archive or remove products and variants."],
  "products.publish": ["Publish products", "Make products visible to buyers, schedule or unpublish them."],
  "categories.view": ["View categories", "See the category tree."],
  "categories.create": ["Create categories", "Add new categories."],
  "categories.edit": ["Edit categories", "Rename, move or reorder categories."],
  "categories.delete": ["Delete categories", "Remove empty categories."],
  "brands.view": ["View brands", "See the store's brands."],
  "brands.create": ["Create brands", "Add new brands."],
  "brands.edit": ["Edit brands", "Change brand names, logos and details."],
  "brands.delete": ["Delete brands", "Remove brands no product uses."],
  "inventory.view": ["View stock", "See stock levels, reservations and movements."],
  "inventory.adjust": ["Adjust stock", "Record stock received, damaged or corrected."],
  "inventory.transfer": ["Transfer stock", "Move stock between warehouses."],
  "inventory.publish": ["Publish stock", "Make stock available for sale to buyers."],
  "warehouses.view": ["View warehouses", "See the store's warehouses and pickup points."],
  "warehouses.create": ["Create warehouses", "Add new warehouses."],
  "warehouses.edit": ["Edit warehouses", "Change warehouse details or deactivate them."],
  "pricing.view": ["View pricing", "See price lists, tiers and margins."],
  "pricing.create": ["Create price lists", "Create price lists and tier prices."],
  "pricing.edit": ["Edit pricing", "Change prices, tiers and price lists."],
  "pricing.approve": ["Approve pricing", "Approve price lists and offers before they go live."],
  "offers.create": ["Create offers", "Create discounts and promotional offers."],
  "offers.edit": ["Edit offers", "Change or end running offers."],
  "coupons.create": ["Create coupons", "Create coupon codes."],
  "coupons.edit": ["Edit coupons", "Change coupon codes, limits and validity, and re-enable them."],
  "coupons.disable": ["Disable coupons", "Disable coupon codes."],
  "orders.view": ["View orders", "See orders, their items, payments and history."],
  "orders.create": ["Place orders", "Place orders (buyers) or create orders on a customer's behalf."],
  "orders.update": ["Process orders", "Confirm, pack, ship and deliver orders."],
  "orders.cancel": ["Cancel orders", "Cancel orders that have not shipped."],
  "orders.refund": ["Refund orders", "Issue refunds and credit notes."],
  "returns.manage": ["Manage returns", "Approve, reject and receive returned items."],
  "cms.view": ["View pages", "See content pages and their versions."],
  "cms.create": ["Create pages", "Create new content pages as drafts."],
  "cms.edit": ["Edit pages", "Edit drafts and send pages for review."],
  "cms.publish": ["Publish pages", "Publish, schedule and unpublish content pages."],
  "chat.view": ["View conversations", "Read customer conversations."],
  "chat.reply": ["Reply to conversations", "Send messages and saved replies to customers."],
  "chat.assign": ["Assign conversations", "Assign, escalate and manage saved replies."],
  "chat.close": ["Close conversations", "Mark conversations as resolved or closed."],
  "reports.view": ["View reports", "See sales, order and stock reports."],
  "reports.export": ["Export reports", "Download reports as CSV files."],
  "analytics.view": ["View analytics", "See traffic, search and conversion analytics."],
  "notifications.create": ["Draft announcements", "Draft announcements and notifications."],
  "notifications.send": ["Send announcements", "Send or schedule announcements to customers and staff."],
  "notifications.manage": ["Manage notifications", "Manage notification templates and settings."],
  "settings.view": ["View settings", "See store or platform settings."],
  "settings.edit": ["Edit settings", "Change store or platform settings and the store profile."],
  "audit.view": ["View audit log", "See who changed what, and failed attempts."],
  "ledger.view": ["View customer ledger", "See customer credit balances and statements."],
  "ledger.manage": ["Manage customer ledger", "Record payments, adjustments and credit terms."],
  "reviews.moderate": ["Moderate reviews", "Hide, restore or delete product reviews."],
  "media.upload": ["Upload media", "Upload and delete images and documents."],
};

/** { key, resource, action, group, label, description } for a permission key. */
export function permissionInfo(key) {
  const [resource, action] = String(key).split(".");
  const [label, description] = PERMISSION_META[key] || [key, key];
  return { key, resource, action, group: PERMISSION_GROUPS[resource] || "Other", label, description };
}

/**
 * Permissions that only the system platform role (super_admin) may hold. They can never be put on a
 * custom or tenant-scoped role — not even by a platform admin — because `authorize("tenants.edit")`
 * etc. are not tenant-scoped checks.
 */
export const PLATFORM_ONLY_PERMISSIONS = ["*", "tenants.view", "tenants.create", "tenants.edit", "tenants.suspend"];

export function isPlatformOnlyPermission(p) {
  return PLATFORM_ONLY_PERMISSIONS.includes(p) || String(p).startsWith("tenants.");
}

export const TENANT_ADMIN_PERMISSIONS = PERMISSIONS.filter((p) => !isPlatformOnlyPermission(p));

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

/** Failed logins before a temporary per-account delay kicks in. */
export const LOCKOUT_THRESHOLD = 5;
/** Upper bound of the progressive delay (30s, 1m, 2m, 4m ... capped here). */
export const LOCKOUT_MINUTES = 15;
export const LOCKOUT_BASE_SECONDS = 30;
export const CART_RESERVATION_MINUTES = 15;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Upload types accepted by utils/storage.js. The type is sniffed from magic bytes, never trusted from the client. */
export const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
/** Folder names accepted by utils/storage.js (anything else -> "general"). */
export const UPLOAD_FOLDERS = ["general", "catalog", "products", "brands", "categories", "cms", "tenants", "avatars", "chat", "invoices", "reviews"];
