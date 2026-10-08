import { Role } from "./role.model.js";
import { Permission } from "./permission.model.js";
import { User } from "../users/user.model.js";
import { AppError } from "../../utils/AppError.js";
import { slugify } from "../../utils/slug.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { PERMISSIONS, SYSTEM_ROLES, isPlatformOnlyPermission, permissionInfo } from "../../config/constants.js";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Permission catalogue with human-readable label/description/group (from config/constants.js,
 * so it is complete even before the Permission collection is re-synced).
 */
export async function listPermissions(req) {
  const keys = req?.isPlatformAdmin ? PERMISSIONS : PERMISSIONS.filter((p) => !isPlatformOnlyPermission(p));
  const stored = await Permission.find({ key: { $in: keys } }).select("_id key createdAt updatedAt").lean();
  const byKey = new Map(stored.map((p) => [p.key, p]));
  return keys
    .map((key) => {
      const row = byKey.get(key);
      return { _id: row?._id, ...permissionInfo(key), platformOnly: isPlatformOnlyPermission(key) };
    })
    .sort((a, b) => a.group.localeCompare(b.group) || a.resource.localeCompare(b.resource) || a.key.localeCompare(b.key));
}

/**
 * Validate a permission list the actor wants to put on a (custom, tenant-scoped) role:
 * - every key must exist in the catalog,
 * - "*" and platform-only keys (tenants.*) are never allowed on such roles,
 * - non-platform actors may only grant permissions they hold themselves.
 */
export function assertGrantable(req, permissions = []) {
  const unique = [...new Set(permissions)];
  const forbidden = unique.filter((p) => isPlatformOnlyPermission(p));
  if (forbidden.length) {
    throw new AppError(403, `Permissions not assignable to tenant roles: ${forbidden.join(", ")}`, "FORBIDDEN");
  }
  const invalid = unique.filter((p) => !PERMISSIONS.includes(p));
  if (invalid.length) {
    throw new AppError(400, `Unknown permissions: ${invalid.join(", ")}`, "VALIDATION_ERROR");
  }
  if (!req.isPlatformAdmin) {
    const held = new Set(req.permissions || []);
    const notHeld = unique.filter((p) => !held.has(p));
    if (notHeld.length) {
      throw new AppError(403, `You cannot grant permissions you do not hold: ${notHeld.join(", ")}`, "FORBIDDEN");
    }
  }
  return unique;
}

/** Non-platform actors may only act on roles whose permissions are a subset of their own. */
export function assertRoleWithinActor(req, role) {
  if (req.isPlatformAdmin) return;
  const held = new Set(req.permissions || []);
  const excess = (role.permissions || []).filter((p) => !held.has(p));
  if (excess.length || role.scope === "platform") {
    throw new AppError(403, "This role has permissions you do not hold", "FORBIDDEN");
  }
}

const BUYER_SLUG = SYSTEM_ROLES.BUYER;

/**
 * Roles visible to the actor, each with `usersCount` (holders, excluding deleted accounts).
 * - Tenant staff: their store's custom roles + the system tenant roles, never the buyer role
 *   or platform roles. Counts are limited to their store's members.
 * - Platform admins: everything (or one store's roles + system roles with a tenant selected).
 *   `scope` = platform | tenant | staff (tenant roles except buyer) | buyer.
 */
export async function listRoles(req) {
  const { page, limit, skip } = paginate(req.query);
  const clauses = [];
  if (!req.isPlatformAdmin) {
    clauses.push({
      $or: [{ tenantId: req.tenantId }, { isSystem: true, scope: "tenant", slug: { $ne: BUYER_SLUG } }],
    });
  } else if (req.tenantId) {
    clauses.push({
      $or: [{ tenantId: req.tenantId }, { isSystem: true }, { tenantId: null, scope: "platform" }],
    });
  }
  const scope = req.query.scope ? String(req.query.scope) : "";
  if (scope === "platform" || scope === "tenant") clauses.push({ scope });
  else if (scope === "staff") clauses.push({ scope: "tenant", $nor: [{ isSystem: true, slug: BUYER_SLUG }] });
  else if (scope === "buyer") clauses.push({ isSystem: true, slug: BUYER_SLUG });
  else if (scope) throw new AppError(400, "scope must be platform, tenant, staff or buyer", "VALIDATION_ERROR");
  if (req.query.system === "true") clauses.push({ isSystem: true });
  if (req.query.system === "false") clauses.push({ isSystem: false });
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(String(req.query.q).slice(0, 100)), "i");
    clauses.push({ $or: [{ name: rx }, { slug: rx }, { description: rx }] });
  }
  const filter = clauses.length ? { $and: clauses } : {};
  const [rows, total] = await Promise.all([
    Role.find(filter).populate("tenantId", "name slug").sort({ isSystem: -1, name: 1 }).skip(skip).limit(limit).lean(),
    Role.countDocuments(filter),
  ]);
  const holderMatch = { roleId: { $in: rows.map((r) => r._id) }, status: { $ne: "deleted" } };
  if (req.tenantId) holderMatch.tenantId = req.tenantId;
  const counts = rows.length
    ? await User.aggregate([{ $match: holderMatch }, { $group: { _id: "$roleId", n: { $sum: 1 } } }])
    : [];
  const byRole = new Map(counts.map((c) => [String(c._id), c.n]));
  const data = rows.map((r) => ({ ...r, id: r._id, usersCount: byRole.get(String(r._id)) || 0 }));
  return paginated(data, total, { page, limit });
}

export async function getRole(req, id) {
  const role = await Role.findById(id);
  if (!role) throw new AppError(404, "Role not found", "NOT_FOUND");
  if (!req.isPlatformAdmin && role.scope === "platform") {
    throw new AppError(403, "Cannot view platform role", "FORBIDDEN");
  }
  if (!req.isPlatformAdmin && role.tenantId && String(role.tenantId) !== String(req.tenantId)) {
    throw new AppError(403, "Cross-tenant access denied", "FORBIDDEN");
  }
  if (!req.isPlatformAdmin && role.isSystem && role.slug === BUYER_SLUG) {
    throw new AppError(404, "Role not found", "NOT_FOUND");
  }
  if (!req.isPlatformAdmin && !role.tenantId && !role.isSystem) {
    throw new AppError(403, "Cross-tenant access denied", "FORBIDDEN");
  }
  return role;
}

export async function createRole(req, body) {
  const tenantId = req.isPlatformAdmin ? body.tenantId || req.tenantId || null : req.tenantId;
  if (!tenantId) {
    throw new AppError(400, "Tenant context required (custom roles belong to a tenant)", "TENANT_REQUIRED");
  }
  const permissions = assertGrantable(req, body.permissions || []);
  const slug = slugify(body.slug || body.name);
  if (!slug) throw new AppError(400, "Invalid role name", "VALIDATION_ERROR");
  const exists = await Role.findOne({ slug, tenantId });
  if (exists) throw new AppError(409, "Role slug already exists", "DUPLICATE");

  return Role.create({
    name: body.name,
    slug,
    tenantId,
    permissions,
    isSystem: false,
    scope: "tenant",
    description: body.description || "",
  });
}

export async function updateRole(req, id, body) {
  const role = await getRole(req, id);
  if (role.isSystem && !req.isPlatformAdmin) {
    throw new AppError(403, "Cannot edit system role", "FORBIDDEN");
  }
  if (role.isSystem && role.scope === "platform") {
    throw new AppError(403, "The platform role cannot be edited", "FORBIDDEN");
  }
  assertRoleWithinActor(req, role);
  if (body.permissions) {
    if (role.isSystem) {
      throw new AppError(403, "System role permissions are defined in code (config/constants.js)", "FORBIDDEN");
    }
    role.permissions = assertGrantable(req, body.permissions);
  }
  if (body.name) role.name = body.name;
  if (body.description !== undefined) role.description = body.description;
  await role.save();
  return role;
}

export async function deleteRole(req, id) {
  const role = await getRole(req, id);
  if (role.isSystem) throw new AppError(403, "Cannot delete system role", "FORBIDDEN");
  assertRoleWithinActor(req, role);
  const holders = await User.countDocuments({ roleId: role._id, status: { $ne: "deleted" } });
  if (holders > 0) {
    throw new AppError(409, `Role is assigned to ${holders} user(s); reassign them first`, "ROLE_IN_USE");
  }
  await role.deleteOne();
  return { ok: true, id: role._id };
}
