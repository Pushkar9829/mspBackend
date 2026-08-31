import { z } from "zod";
import { TENANT_STATUSES } from "../../config/constants.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const createTenantSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(120),
    slug: z.string().min(2).max(80).optional(),
    status: z.enum(TENANT_STATUSES).optional(),
    admin: z
      .object({
        name: z.string().min(2),
        email: z.string().email(),
        password: z.string().min(8),
      })
      .optional(),
    branding: z.object({}).passthrough().optional(),
    businessProfile: z.object({}).passthrough().optional(),
    taxSettings: z.object({}).passthrough().optional(),
    orderRules: z.object({}).passthrough().optional(),
    deliveryZones: z.array(z.object({}).passthrough()).optional(),
  }),
});

export const updateTenantSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    name: z.string().min(2).max(120).optional(),
    status: z.enum(TENANT_STATUSES).optional(),
    branding: z.object({}).passthrough().optional(),
    businessProfile: z.object({}).passthrough().optional(),
    taxSettings: z.object({}).passthrough().optional(),
    orderRules: z.object({}).passthrough().optional(),
    deliveryZones: z.array(z.object({}).passthrough()).optional(),
    notificationPreferences: z.object({}).passthrough().optional(),
  }),
});

export const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});

export const updateMineSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(120).optional(),
    branding: z.object({}).passthrough().optional(),
    businessProfile: z.object({}).passthrough().optional(),
    taxSettings: z.object({}).passthrough().optional(),
    orderRules: z.object({}).passthrough().optional(),
    deliveryZones: z.array(z.object({}).passthrough()).optional(),
    notificationPreferences: z.object({}).passthrough().optional(),
  }),
});
