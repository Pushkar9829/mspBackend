import bcrypt from "bcryptjs";
import { Permission } from "../modules/rbac/permission.model.js";
import { Role } from "../modules/rbac/role.model.js";
import { User } from "../modules/users/user.model.js";
import { Settings } from "../modules/settings/settings.model.js";
import {
  PERMISSIONS,
  SYSTEM_ROLES,
  TENANT_ADMIN_PERMISSIONS,
  SUPPORT_AGENT_PERMISSIONS,
  BUYER_PERMISSIONS,
  permissionInfo,
} from "../config/constants.js";
import { env } from "../config/env.js";
import { SALT } from "../modules/auth/service.js";
import { logger } from "../utils/logger.js";
import { ensureDefaultCmsPages } from "./cmsDefaults.js";

const SYSTEM_ROLE_DEFS = [
  {
    slug: SYSTEM_ROLES.SUPER_ADMIN,
    name: "Super Admin",
    permissions: ["*"],
    scope: "platform",
    description: "Platform-wide access",
  },
  {
    slug: SYSTEM_ROLES.TENANT_ADMIN,
    name: "Tenant Admin",
    permissions: TENANT_ADMIN_PERMISSIONS,
    scope: "tenant",
    description: "Full tenant operations",
  },
  {
    slug: SYSTEM_ROLES.SUPPORT_AGENT,
    name: "Support Agent",
    permissions: SUPPORT_AGENT_PERMISSIONS,
    scope: "tenant",
    description: "Chat and order support",
  },
  {
    slug: SYSTEM_ROLES.BUYER,
    name: "Buyer",
    permissions: BUYER_PERMISSIONS,
    scope: "tenant",
    description: "Marketplace buyer",
  },
];

/**
 * Permission catalog + system roles. System role permissions are code-defined and re-synced on
 * every start (safe, idempotent). Runs on every boot.
 */
export async function ensureSystemRoles() {
  for (const key of PERMISSIONS) {
    const { resource, action, description } = permissionInfo(key);
    await Permission.updateOne({ key }, { $set: { key, resource, action, description } }, { upsert: true });
  }
  const out = {};
  for (const def of SYSTEM_ROLE_DEFS) {
    out[def.slug] = await Role.findOneAndUpdate(
      { slug: def.slug, isSystem: true },
      { $set: { ...def, tenantId: null, isSystem: true } },
      { upsert: true, new: true }
    );
  }
  return out;
}

/**
 * Foundation seed: system roles, the super admin (created ONLY if absent — an existing account's
 * password, status and lockout are never touched), and default platform settings (insert-only).
 */
export async function seedFoundation() {
  const roles = await ensureSystemRoles();
  const superAdmin = roles[SYSTEM_ROLES.SUPER_ADMIN];

  const email = env.superAdminEmail.toLowerCase();
  const existingAdmin = await User.findOne({ email }).select("_id");
  if (!existingAdmin) {
    try {
      await User.create({
        name: "Super Admin",
        email,
        passwordHash: await bcrypt.hash(env.superAdminPassword, SALT),
        tenantId: null,
        roleId: superAdmin._id,
        status: "active",
        emailVerified: true,
        emailVerifiedAt: new Date(),
      });
      logger.info("Seeded super admin", { email });
    } catch (err) {
      if (err?.code !== 11000) throw err; // another instance created it concurrently
    }
  }

  const platformSettings = [
    ["platform.name", "MSP Wholesale Marketplace"],
    ["platform.currency", "INR"],
    ["platform.supportEmail", "support@msp.local"],
    ["platform.defaultTaxRate", 18],
    ["platform.mapsProvider", env.mapsProvider || "stub"],
    ["platform.slogan", "भाव भी भरोसा भी"],
  ];
  for (const [key, value] of platformSettings) {
    await Settings.updateOne(
      { scope: "platform", tenantId: null, key },
      { $setOnInsert: { value } },
      { upsert: true }
    );
  }

  // Global policy pages (grievance, terms, privacy, refunds, shipping, about): insert-only.
  await ensureDefaultCmsPages();

  return { ok: true };
}

export { seedDemoCatalog } from "./demo.js";
