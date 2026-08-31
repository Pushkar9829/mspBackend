import { Role } from "./role.model.js";
import { Permission } from "./permission.model.js";
import { AppError } from "../../utils/AppError.js";
import { slugify } from "../../utils/slug.js";
import { PERMISSIONS } from "../../config/constants.js";
import { tenantFilter } from "../../middleware/tenantScope.js";

export async function listPermissions() {
  return Permission.find().sort({ resource: 1, action: 1 });
}

export async function listRoles(req) {
  const filter = tenantFilter(req);
  if (!req.isPlatformAdmin) {
    filter.$or = [{ tenantId: req.tenantId }, { isSystem: true, scope: "tenant" }];
    delete filter.tenantId;
  }
  return Role.find(filter).sort({ isSystem: -1, name: 1 });
}

export async function getRole(req, id) {
  const role = await Role.findById(id);
  if (!role) throw new AppError(404, "Role not found", "NOT_FOUND");
  if (!req.isPlatformAdmin && role.scope === "platform") {
    throw new AppError(403, "Cannot view platform role", "FORBIDDEN");
  }
  if (
    !req.isPlatformAdmin &&
    role.tenantId &&
    String(role.tenantId) !== String(req.tenantId)
  ) {
    throw new AppError(403, "Cross-tenant access denied", "FORBIDDEN");
  }
  return role;
}

export async function createRole(req, body) {
  if (!req.tenantId && !req.isPlatformAdmin) {
    throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  }
  const slug = slugify(body.slug || body.name);
  const tenantId = req.isPlatformAdmin ? req.tenantId : req.tenantId;
  const exists = await Role.findOne({ slug, tenantId: tenantId || null });
  if (exists) throw new AppError(409, "Role slug already exists", "DUPLICATE");

  const invalid = (body.permissions || []).filter((p) => p !== "*" && !PERMISSIONS.includes(p));
  if (invalid.length) {
    throw new AppError(400, `Unknown permissions: ${invalid.join(", ")}`, "VALIDATION_ERROR");
  }

  return Role.create({
    name: body.name,
    slug,
    tenantId: tenantId || null,
    permissions: body.permissions || [],
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
  if (body.permissions) {
    const invalid = body.permissions.filter((p) => p !== "*" && !PERMISSIONS.includes(p));
    if (invalid.length) {
      throw new AppError(400, `Unknown permissions: ${invalid.join(", ")}`, "VALIDATION_ERROR");
    }
    role.permissions = body.permissions;
  }
  if (body.name) role.name = body.name;
  if (body.description !== undefined) role.description = body.description;
  await role.save();
  return role;
}

export async function deleteRole(req, id) {
  const role = await getRole(req, id);
  if (role.isSystem) throw new AppError(403, "Cannot delete system role", "FORBIDDEN");
  await role.deleteOne();
  return { ok: true, id: role._id };
}
