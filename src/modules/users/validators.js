import { z } from "zod";
import { USER_STATUSES } from "../../config/constants.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const createUserSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(120),
    email: z.string().email(),
    password: z.string().min(8).max(100),
    phone: z.string().max(20).optional(),
    roleId: objectId,
    tenantId: objectId.optional(),
    status: z.enum(USER_STATUSES).optional(),
    profile: z.object({}).passthrough().optional(),
  }),
});

export const updateUserSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    name: z.string().min(2).max(120).optional(),
    phone: z.string().max(20).optional(),
    roleId: objectId.optional(),
    status: z.enum(USER_STATUSES).optional(),
    profile: z.object({}).passthrough().optional(),
  }),
});

export const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});
