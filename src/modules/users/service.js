import bcrypt from "bcryptjs";
import { User } from "./user.model.js";
import { Role } from "../rbac/role.model.js";
import { AppError } from "../../utils/AppError.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import { toPublicUser, SALT } from "../auth/service.js";

export async function listUsers(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = tenantFilter(req);
  if (req.query.status) filter.status = req.query.status;
  if (req.query.role) {
    const role = await Role.findOne({ slug: req.query.role });
    if (role) filter.roleId = role._id;
  }
  if (req.query.q) {
    filter.$or = [
      { name: new RegExp(req.query.q, "i") },
      { email: new RegExp(req.query.q, "i") },
    ];
  }
  const [rows, total] = await Promise.all([
    User.find(filter).populate("roleId").populate("tenantId", "name slug").sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);
  return paginated(
    rows.map((u) => toPublicUser(u, u.roleId)),
    total,
    { page, limit }
  );
}

export async function getUser(req, id) {
  const user = await User.findOne({ _id: id, ...tenantFilter(req) }).populate("roleId").populate("tenantId", "name slug");
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  return toPublicUser(user, user.roleId);
}

export async function createUser(req, body) {
  const existing = await User.findOne({ email: body.email.toLowerCase() });
  if (existing) throw new AppError(409, "Email already registered", "DUPLICATE");

  const role = await Role.findById(body.roleId);
  if (!role) throw new AppError(400, "Role not found", "NOT_FOUND");

  if (!req.isPlatformAdmin && role.scope === "platform") {
    throw new AppError(403, "Cannot assign platform role", "FORBIDDEN");
  }

  const tenantId = req.isPlatformAdmin ? body.tenantId || req.tenantId || null : req.tenantId;
  if (role.scope === "tenant" && !tenantId) {
    throw new AppError(400, "tenantId is required for tenant roles", "VALIDATION_ERROR");
  }

  const user = await User.create({
    name: body.name,
    email: body.email.toLowerCase(),
    phone: body.phone || "",
    passwordHash: await bcrypt.hash(body.password, SALT),
    tenantId,
    roleId: role._id,
    status: body.status || "active",
    profile: body.profile || {},
  });
  await user.populate("roleId");
  return toPublicUser(user, user.roleId);
}

export async function updateUser(req, id, body) {
  const user = await User.findOne({ _id: id, ...tenantFilter(req) });
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");

  if (body.roleId) {
    const role = await Role.findById(body.roleId);
    if (!role) throw new AppError(400, "Role not found", "NOT_FOUND");
    if (!req.isPlatformAdmin && role.scope === "platform") {
      throw new AppError(403, "Cannot assign platform role", "FORBIDDEN");
    }
    user.roleId = role._id;
  }
  if (body.name) user.name = body.name;
  if (body.phone !== undefined) user.phone = body.phone;
  if (body.status) user.status = body.status;
  if (body.profile) user.profile = { ...user.profile?.toObject?.() || user.profile, ...body.profile };
  await user.save();
  await user.populate("roleId");
  return toPublicUser(user, user.roleId);
}

export async function deleteUser(req, id) {
  const user = await User.findOne({ _id: id, ...tenantFilter(req) });
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  user.status = "suspended";
  await user.save();
  return { ok: true, id: user._id };
}
