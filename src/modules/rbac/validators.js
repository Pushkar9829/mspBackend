import { z } from "zod";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const createRoleSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(80),
    slug: z.string().min(2).max(80).optional(),
    permissions: z.array(z.string()).default([]),
    description: z.string().max(300).optional(),
  }),
});

export const updateRoleSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    name: z.string().min(2).max(80).optional(),
    permissions: z.array(z.string()).optional(),
    description: z.string().max(300).optional(),
  }),
});

export const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});
