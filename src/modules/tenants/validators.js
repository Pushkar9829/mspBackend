import { z } from "zod";
import { TENANT_STATUSES } from "../../config/constants.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const hexColor = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "Invalid color");
const str = (max) => z.string().trim().max(max);

const branding = z.object({
  logo: str(500).optional(),
  primaryColor: hexColor.optional(),
  secondaryColor: hexColor.optional(),
});

const businessProfile = z.object({
  legalName: str(200).optional(),
  gstin: z.string().trim().toUpperCase().regex(/^$|^[0-9A-Z]{15}$/, "Invalid GSTIN").optional(),
  email: z.union([z.literal(""), z.string().trim().email().max(254)]).optional(),
  phone: str(20).optional(),
  website: str(300).optional(),
});

const taxSettings = z.object({
  defaultTaxRate: z.number().min(0).max(28).optional(),
  currency: z.literal("INR").optional(),
});

const orderRules = z.object({
  minOrderValue: z.number().min(0).max(10000000).optional(),
  allowBackorder: z.boolean().optional(),
});

const pickupAddress = z.object({
  label: str(80).optional(),
  contactName: str(120).optional(),
  phone: str(20).optional(),
  addressLine1: str(200).optional(),
  city: str(80).optional(),
  state: str(80).optional(),
  postalCode: str(12).optional(),
  country: str(2).optional(),
});

const deliveryZone = z.object({
  name: str(80).min(1),
  pincodes: z.array(z.string().trim().regex(/^\d{6}$/, "Invalid pincode")).max(5000).optional(),
  radiusKm: z.number().min(0).max(2000).nullable().optional(),
  center: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional(),
  etaDaysMin: z.number().int().min(0).max(60).optional(),
  etaDaysMax: z.number().int().min(0).max(90).optional(),
  deliveryFee: z.number().min(0).max(100000).optional(),
});

const notificationPreferences = z.object({
  email: z.boolean().optional(),
  inApp: z.boolean().optional(),
});

const profileFields = {
  name: z.string().trim().min(2).max(120).optional(),
  branding: branding.optional(),
  businessProfile: businessProfile.optional(),
  taxSettings: taxSettings.optional(),
  orderRules: orderRules.optional(),
  deliveryZones: z.array(deliveryZone).max(200).optional(),
  pickupAddress: pickupAddress.optional(),
  notificationPreferences: notificationPreferences.optional(),
};

export const createTenantSchema = z.object({
  body: z.object({
    ...profileFields,
    name: z.string().trim().min(2).max(120),
    slug: z.string().trim().min(2).max(80).optional(),
    status: z.enum(TENANT_STATUSES).optional(),
    admin: z
      .object({
        name: z.string().trim().min(2).max(120),
        email: z.string().trim().email().max(254),
        password: z.string().min(8).max(100),
      })
      .optional(),
  }),
});

export const updateTenantSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    ...profileFields,
    status: z.enum(TENANT_STATUSES).optional(),
  }),
});

export const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});

/** PATCH /tenants/me — tenant staff with settings.edit; no status/slug changes. */
export const updateMineSchema = z.object({
  body: z.object(profileFields),
});

const statusList = z
  .string()
  .max(200)
  .refine((v) => v.split(",").map((s) => s.trim()).filter(Boolean).every((s) => TENANT_STATUSES.includes(s)), "Invalid status");

export const listTenantsSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      q: z.string().max(100).optional(),
      status: statusList.optional(),
      sort: z.enum(["createdAt", "updatedAt", "name", "slug", "status"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    })
    .passthrough(),
});
