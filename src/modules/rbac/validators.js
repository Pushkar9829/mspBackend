import { z } from "zod";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const permissionKey = z.string().min(1).max(60);

export const createRoleSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(80),
    slug: z.string().trim().min(2).max(80).optional(),
    permissions: z.array(permissionKey).max(200).default([]),
    description: z.string().max(300).optional(),
    tenantId: objectId.optional(),
  }),
});

export const updateRoleSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    name: z.string().trim().min(2).max(80).optional(),
    permissions: z.array(permissionKey).max(200).optional(),
    description: z.string().max(300).optional(),
  }),
});

export const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});
