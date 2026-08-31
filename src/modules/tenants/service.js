import bcrypt from "bcryptjs";
import { Tenant } from "./tenant.model.js";
import { User } from "../users/user.model.js";
import { Role } from "../rbac/role.model.js";
import { AppError } from "../../utils/AppError.js";
import { slugify } from "../../utils/slug.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { SYSTEM_ROLES } from "../../config/constants.js";
import { SALT } from "../auth/service.js";
import { emitDomain } from "../../utils/events.js";

export async function listTenants(query) {
  const { page, limit, skip } = paginate(query);
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.q) {
    filter.$or = [
      { name: new RegExp(query.q, "i") },
      { slug: new RegExp(query.q, "i") },
    ];
  }
  const [data, total] = await Promise.all([
    Tenant.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Tenant.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}

export async function getTenant(id) {
  const tenant = await Tenant.findById(id);
  if (!tenant) throw new AppError(404, "Tenant not found", "NOT_FOUND");
  return tenant;
}

export async function createTenant(body) {
  const slug = slugify(body.slug || body.name);
  const exists = await Tenant.findOne({ slug });
  if (exists) throw new AppError(409, "Slug already in use", "DUPLICATE");

  const tenant = await Tenant.create({
    name: body.name,
    slug,
    status: body.status || "pending",
    branding: body.branding,
    businessProfile: body.businessProfile,
    taxSettings: body.taxSettings,
    orderRules: body.orderRules,
    deliveryZones: body.deliveryZones || [],
  });

  if (body.admin) {
    const role = await Role.findOne({ slug: SYSTEM_ROLES.TENANT_ADMIN, isSystem: true });
    if (!role) throw new AppError(500, "Tenant admin role not seeded", "SERVER_ERROR");
    const existing = await User.findOne({ email: body.admin.email.toLowerCase() });
    if (existing) throw new AppError(409, "Admin email already registered", "DUPLICATE");
    await User.create({
      name: body.admin.name,
      email: body.admin.email.toLowerCase(),
      passwordHash: await bcrypt.hash(body.admin.password, SALT),
      tenantId: tenant._id,
      roleId: role._id,
      status: "active",
    });
  }

  return tenant;
}

export async function updateTenant(id, body) {
  const before = await Tenant.findById(id);
  if (!before) throw new AppError(404, "Tenant not found", "NOT_FOUND");
  const tenant = await Tenant.findByIdAndUpdate(id, body, {
    new: true,
    runValidators: true,
  });
  if (body.status === "suspended" && before.status !== "suspended") {
    emitDomain("TENANT_SUSPENDED", {
      tenantId: tenant._id,
      resource: "tenant",
      resourceId: tenant._id,
    });
  }
  return tenant;
}

export async function getMyTenant(req) {
  const tenantId = req.user?.tenantId?._id || req.user?.tenantId;
  if (!tenantId) throw new AppError(400, "No tenant on this account", "TENANT_REQUIRED");
  return getTenant(tenantId);
}

export async function updateMyTenant(req, body) {
  const tenantId = req.user?.tenantId?._id || req.user?.tenantId;
  if (!tenantId) throw new AppError(400, "No tenant on this account", "TENANT_REQUIRED");
  const allowed = {
    name: body.name,
    branding: body.branding,
    businessProfile: body.businessProfile,
    taxSettings: body.taxSettings,
    orderRules: body.orderRules,
    deliveryZones: body.deliveryZones,
    notificationPreferences: body.notificationPreferences,
  };
  const patch = Object.fromEntries(Object.entries(allowed).filter(([, v]) => v !== undefined));
  return updateTenant(tenantId, patch);
}
