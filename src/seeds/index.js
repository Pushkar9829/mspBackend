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
} from "../config/constants.js";
import { env } from "../config/env.js";
import { SALT } from "../modules/auth/service.js";

export async function seedFoundation() {
  for (const key of PERMISSIONS) {
    const [resource, action] = key.split(".");
    await Permission.updateOne(
      { key },
      { $set: { key, resource, action, description: key } },
      { upsert: true }
    );
  }

  const superAdmin = await Role.findOneAndUpdate(
    { slug: SYSTEM_ROLES.SUPER_ADMIN, isSystem: true },
    {
      $set: {
        name: "Super Admin",
        slug: SYSTEM_ROLES.SUPER_ADMIN,
        tenantId: null,
        permissions: ["*"],
        isSystem: true,
        scope: "platform",
        description: "Platform-wide access",
      },
    },
    { upsert: true, new: true }
  );

  await Role.findOneAndUpdate(
    { slug: SYSTEM_ROLES.TENANT_ADMIN, isSystem: true },
    {
      $set: {
        name: "Tenant Admin",
        slug: SYSTEM_ROLES.TENANT_ADMIN,
        tenantId: null,
        permissions: TENANT_ADMIN_PERMISSIONS,
        isSystem: true,
        scope: "tenant",
        description: "Full tenant operations",
      },
    },
    { upsert: true }
  );

  await Role.findOneAndUpdate(
    { slug: SYSTEM_ROLES.SUPPORT_AGENT, isSystem: true },
    {
      $set: {
        name: "Support Agent",
        slug: SYSTEM_ROLES.SUPPORT_AGENT,
        tenantId: null,
        permissions: SUPPORT_AGENT_PERMISSIONS,
        isSystem: true,
        scope: "tenant",
        description: "Chat and order support",
      },
    },
    { upsert: true }
  );

  await Role.findOneAndUpdate(
    { slug: SYSTEM_ROLES.BUYER, isSystem: true },
    {
      $set: {
        name: "Buyer",
        slug: SYSTEM_ROLES.BUYER,
        tenantId: null,
        permissions: BUYER_PERMISSIONS,
        isSystem: true,
        scope: "tenant",
        description: "Wholesale buyer",
      },
    },
    { upsert: true }
  );

  const existingAdmin = await User.findOne({ email: env.superAdminEmail.toLowerCase() });
  const adminHash = await bcrypt.hash(env.superAdminPassword, SALT);
  if (!existingAdmin) {
    await User.create({
      name: "Super Admin",
      email: env.superAdminEmail.toLowerCase(),
      passwordHash: adminHash,
      tenantId: null,
      roleId: superAdmin._id,
      status: "active",
    });
    console.log(`Seeded super admin ${env.superAdminEmail}`);
  } else {
    await User.updateOne(
      { _id: existingAdmin._id },
      {
        $set: {
          passwordHash: adminHash,
          roleId: superAdmin._id,
          status: "active",
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }
    );
  }

  const platformSettings = [
    ["platform.name", "MSP Wholesale Marketplace"],
    ["platform.currency", "INR"],
    ["platform.supportEmail", "support@msp.local"],
    ["platform.defaultTaxRate", 18],
    ["platform.mapsProvider", env.mapsProvider || "stub"],
  ];
  for (const [key, value] of platformSettings) {
    await Settings.findOneAndUpdate(
      { scope: "platform", tenantId: null, key },
      { $set: { value } },
      { upsert: true }
    );
  }

  return { ok: true };
}

export { seedDemoCatalog } from "./demo.js";

