import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { User } from "./user.model.js";
import { Role } from "../rbac/role.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { AppError } from "../../utils/AppError.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { asObjectId } from "../../middleware/tenantScope.js";
import { toPublicUser, SALT, bumpTokenVersion } from "../auth/service.js";
import { assertRoleWithinActor } from "../rbac/service.js";
import { Address } from "../location/address.model.js";
import { SYSTEM_ROLES } from "../../config/constants.js";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDate(value, endOfDay = false) {
  if (!value) return null;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T23:59:59.999+05:30`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Which users the actor can see. Tenant staff see their members plus marketplace buyers whose
 * storefront affinity (homeTenantId) is their store (read-only). Platform admins see all
 * (or the selected tenant's).
 */
function visibilityFilter(req) {
  if (req.isPlatformAdmin && !req.tenantId) return {};
  return { $or: [{ tenantId: req.tenantId }, { tenantId: null, homeTenantId: req.tenantId }] };
}

/** Which users the actor may modify: members of their own tenant only (platform admin: anyone). */
function manageFilter(req) {
  if (req.isPlatformAdmin && !req.tenantId) return {};
  if (req.isPlatformAdmin) return visibilityFilter(req);
  return { tenantId: req.tenantId };
}

function isBuyerRoleDoc(role) {
  return Boolean(role?.isSystem && role.slug === SYSTEM_ROLES.BUYER);
}

/**
 * Check that `role` may be given to a user of `tenantId` by this actor.
 * - platform roles: platform admin only, user must have no tenant;
 * - tenant roles: must be a system tenant role or a custom role of the same tenant;
 * - non-platform actors may only assign roles whose permissions they hold.
 */
async function loadAssignableRole(req, roleId, tenantId) {
  const role = await Role.findById(roleId);
  if (!role) throw new AppError(400, "Role not found", "NOT_FOUND");
  if (role.scope === "platform") {
    if (!req.isPlatformAdmin) throw new AppError(403, "Cannot assign platform role", "FORBIDDEN");
    return role;
  }
  // Marketplace buyer accounts are platform-wide (not tenant members); store staff must not mint
  // pre-verified buyers — buyers self-register (with email verification) or are created by platform admins.
  if (isBuyerRoleDoc(role) && !req.isPlatformAdmin) {
    throw new AppError(403, "Cannot assign the buyer role", "FORBIDDEN");
  }
  const systemTenantRole = role.isSystem && role.scope === "tenant" && !role.tenantId;
  const sameTenant = role.tenantId && tenantId && String(role.tenantId) === String(tenantId);
  if (!systemTenantRole && !sameTenant) {
    throw new AppError(403, "Role belongs to another tenant", "FORBIDDEN");
  }
  assertRoleWithinActor(req, role);
  return role;
}

const USER_SORT_FIELDS = { createdAt: "createdAt", name: "name", email: "email", lastLoginAt: "lastLoginAt", status: "status", updatedAt: "updatedAt" };

function userSort(query = {}) {
  const field = USER_SORT_FIELDS[String(query.sort || "")] || "createdAt";
  const dir = String(query.order || "").toLowerCase() === "asc" ? 1 : -1;
  return { [field]: dir, _id: dir };
}

export async function listUsers(req) {
  const { page, limit, skip } = paginate(req.query);
  const and = [visibilityFilter(req)];
  if (req.query.status) and.push({ status: String(req.query.status) });
  if (req.query.roleId && mongoose.Types.ObjectId.isValid(String(req.query.roleId))) {
    and.push({ roleId: String(req.query.roleId) });
  } else if (req.query.role) {
    const roles = await Role.find({ slug: String(req.query.role) }).select("_id isSystem tenantId");
    if (!roles.length) {
      and.push({ roleId: null });
    } else if (req.tenantId) {
      const picked =
        roles.find((r) => r.isSystem) || roles.find((r) => String(r.tenantId) === String(req.tenantId)) || roles[0];
      and.push({ roleId: picked._id });
    } else {
      and.push({ roleId: { $in: roles.map((r) => r._id) } });
    }
  }
  if (req.query.staff === "true" || req.query.staff === "false") {
    const buyer = await Role.findOne({ slug: SYSTEM_ROLES.BUYER, isSystem: true }).select("_id");
    if (req.query.staff === "true") {
      // Staff = store members (and platform users for platform admins); never marketplace buyers.
      and.push(buyer ? { roleId: { $ne: buyer._id } } : {});
    } else {
      and.push({ roleId: buyer ? buyer._id : null });
    }
  }
  if (req.query.emailVerified === "true") and.push({ emailVerified: true });
  if (req.query.emailVerified === "false") and.push({ emailVerified: { $ne: true } });
  if (req.query.homeTenantId) {
    const home = asObjectId(req.query.homeTenantId);
    if (!home) throw new AppError(400, "Invalid homeTenantId", "VALIDATION_ERROR");
    and.push({ homeTenantId: home });
  }
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to, true);
  if ((req.query.from && !from) || (req.query.to && !to)) throw new AppError(400, "Invalid date", "VALIDATION_ERROR");
  if (from || to) {
    const createdAt = {};
    if (from) createdAt.$gte = from;
    if (to) createdAt.$lte = to;
    and.push({ createdAt });
  }
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(String(req.query.q).trim().slice(0, 100)), "i");
    and.push({ $or: [{ name: rx }, { email: rx }, { phone: rx }, { "profile.company": rx }] });
  }
  and.push({ status: { $ne: "deleted" } });
  const filter = { $and: and.filter((c) => Object.keys(c).length) };
  const [rows, total] = await Promise.all([
    User.find(filter)
      .populate("roleId")
      .populate("tenantId", "name slug")
      .populate("homeTenantId", "name slug")
      .collation({ locale: "en", strength: 2 })
      .sort(userSort(req.query))
      .skip(skip)
      .limit(limit),
    User.countDocuments(filter),
  ]);
  const addresses = rows.length
    ? await Address.find({ userId: { $in: rows.map((u) => u._id) } }).sort({ isDefault: -1, updatedAt: -1 })
    : [];
  const addressByUser = new Map();
  for (const address of addresses) {
    const key = String(address.userId);
    if (!addressByUser.has(key)) addressByUser.set(key, address);
  }
  return paginated(
    rows.map((u) => {
      const pub = toPublicUser(u, u.roleId);
      const saved = addressByUser.get(String(u._id));
      if (!saved) return pub;
      const profile = pub.profile || {};
      return {
        ...pub,
        phone: pub.phone || saved.phone || "",
        profile: {
          ...profile,
          addressLine1: profile.addressLine1 || saved.addressLine1,
          location: {
            city: profile.location?.city || saved.city,
            state: profile.location?.state || saved.state,
            postalCode: profile.location?.postalCode || saved.postalCode,
            country: profile.location?.country || saved.country || "IN",
          },
        },
      };
    }),
    total,
    { page, limit }
  );
}

export async function getUser(req, id) {
  const user = await User.findOne({ _id: id, ...visibilityFilter(req) })
    .populate("roleId")
    .populate("tenantId", "name slug")
    .populate("homeTenantId", "name slug");
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  return toPublicUser(user, user.roleId);
}

export async function createUser(req, body) {
  const email = body.email.toLowerCase();
  const existing = await User.findOne({ email }).select("_id");
  if (existing) throw new AppError(409, "Email already registered", "DUPLICATE");

  let tenantId = req.isPlatformAdmin ? asObjectId(body.tenantId) || req.tenantId || null : req.tenantId;
  if (tenantId && req.isPlatformAdmin && !(await Tenant.exists({ _id: tenantId }))) {
    throw new AppError(400, "Tenant not found", "NOT_FOUND");
  }
  const role = await loadAssignableRole(req, body.roleId, tenantId);

  let homeTenantId = null;
  if (role.scope === "platform") {
    tenantId = null;
  } else if (isBuyerRoleDoc(role)) {
    // Buyers are marketplace customers, never tenant members.
    homeTenantId = tenantId || null;
    tenantId = null;
  } else if (!tenantId) {
    throw new AppError(400, "tenantId is required for tenant roles", "VALIDATION_ERROR");
  }

  const user = await User.create({
    name: body.name,
    email,
    phone: body.phone || "",
    passwordHash: await bcrypt.hash(body.password, SALT),
    tenantId,
    homeTenantId,
    roleId: role._id,
    status: body.status || "active",
    emailVerified: true, // created by an administrator
    emailVerifiedAt: new Date(),
    profile: body.profile || {},
  });
  await user.populate("roleId");
  return toPublicUser(user, user.roleId);
}

export async function updateUser(req, id, body) {
  const user = await User.findOne({ _id: id, ...manageFilter(req) }).populate("roleId");
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  const isSelf = String(user._id) === String(req.user._id);
  if (user.roleId) assertRoleWithinActor(req, user.roleId);
  if (!req.isPlatformAdmin && user.roleId?.scope === "platform") {
    throw new AppError(403, "Cannot edit platform users", "FORBIDDEN");
  }

  let revoke = false;
  if (body.roleId && String(body.roleId) !== String(user.roleId?._id)) {
    if (isSelf) throw new AppError(403, "You cannot change your own role", "FORBIDDEN");
    const role = await loadAssignableRole(req, body.roleId, user.tenantId || user.homeTenantId);
    if (isBuyerRoleDoc(role) !== isBuyerRoleDoc(user.roleId) || (role.scope === "platform") !== (user.roleId?.scope === "platform")) {
      throw new AppError(400, "Cannot convert between buyer, staff and platform accounts", "VALIDATION_ERROR");
    }
    user.roleId = role._id;
    revoke = true;
  }
  if (body.status && body.status !== user.status) {
    if (isSelf) throw new AppError(403, "You cannot change your own status", "FORBIDDEN");
    user.status = body.status;
    if (body.status !== "active") revoke = true;
  }
  if (body.name) user.name = body.name;
  if (body.phone !== undefined) user.phone = body.phone;
  if (body.profile) {
    for (const [key, value] of Object.entries(body.profile)) {
      if (key === "location") {
        for (const [lk, lv] of Object.entries(value || {})) user.set(`profile.location.${lk}`, lv);
      } else {
        user.set(`profile.${key}`, value);
      }
    }
  }
  await user.save();
  if (revoke) await bumpTokenVersion(user._id, "role_or_status_change");
  await user.populate("roleId");
  return toPublicUser(user, user.roleId);
}

export async function deleteUser(req, id) {
  const user = await User.findOne({ _id: id, ...manageFilter(req) }).populate("roleId");
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  if (String(user._id) === String(req.user._id)) {
    throw new AppError(403, "You cannot deactivate your own account here", "FORBIDDEN");
  }
  if (user.roleId) assertRoleWithinActor(req, user.roleId);
  user.status = "suspended";
  await user.save();
  await bumpTokenVersion(user._id, "suspended");
  return { ok: true, id: user._id };
}

/**
 * Revoke every session of a user (bumps tokenVersion + revokes refresh sessions).
 * Platform admins: any user. Tenant staff with users.edit: members of their own store whose role
 * does not exceed their own permissions (buyers and platform users are out of reach).
 */
export async function signOutEverywhere(req, id) {
  const user = await User.findOne({ _id: id, ...manageFilter(req) }).populate("roleId");
  if (!user || user.status === "deleted") throw new AppError(404, "User not found", "NOT_FOUND");
  if (!req.isPlatformAdmin) {
    if (user.roleId?.scope === "platform") throw new AppError(403, "Cannot manage platform users", "FORBIDDEN");
    if (user.roleId) assertRoleWithinActor(req, user.roleId);
  }
  await bumpTokenVersion(user._id, "admin_sign_out");
  return { ok: true, id: user._id, revokedAt: new Date() };
}
