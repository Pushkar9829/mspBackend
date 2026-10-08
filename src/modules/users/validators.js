import { z } from "zod";
import { profileSchema } from "../auth/validators.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
/** Statuses an administrator may set ("locked"/"deleted" are system-managed). */
const ADMIN_STATUSES = ["active", "pending", "suspended"];

export const createUserSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(254),
    password: z.string().min(8).max(100),
    phone: z.string().trim().max(20).optional(),
    roleId: objectId,
    tenantId: objectId.optional(),
    status: z.enum(ADMIN_STATUSES).optional(),
    profile: profileSchema.optional(),
  }),
});

export const updateUserSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().max(20).optional(),
    roleId: objectId.optional(),
    status: z.enum(ADMIN_STATUSES).optional(),
    profile: profileSchema.optional(),
  }),
});

export const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});

const bool = z.enum(["true", "false"]);
const dateLike = z.string().trim().max(40).refine((v) => !Number.isNaN(new Date(v.length === 10 ? `${v}T00:00:00Z` : v).getTime()), "Invalid date");

export const listUsersSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      q: z.string().max(100).optional(),
      status: z.enum(["active", "pending", "suspended", "locked", "deleted"]).optional(),
      role: z.string().max(80).optional(),
      roleId: objectId.optional(),
      homeTenantId: objectId.optional(),
      tenantId: objectId.optional(),
      staff: bool.optional(),
      emailVerified: bool.optional(),
      from: dateLike.optional(),
      to: dateLike.optional(),
      sort: z.enum(["createdAt", "name", "email", "lastLoginAt", "status", "updatedAt"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    })
    .passthrough(),
});
