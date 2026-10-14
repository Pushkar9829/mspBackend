import { z } from "zod";
import { TENANT_STATUSES } from "../../config/constants.js";
import { normalizeGstin } from "../../utils/gstin.js";
import { isIndianPhone, isHttpUrl, PHONE_MESSAGE, URL_MESSAGE } from "../../utils/phone.js";
import { newPassword } from "../../utils/password.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const hexColor = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "Invalid color");
const str = (max) => z.string().trim().max(max);
/** Empty clears the field; anything else must be a valid Indian phone / http(s) URL. */
const phoneField = str(20).refine((v) => v === "" || isIndianPhone(v), PHONE_MESSAGE);
const websiteField = str(300).refine((v) => v === "" || isHttpUrl(v), URL_MESSAGE);

const branding = z.object({
  logo: str(500).optional(),
  primaryColor: hexColor.optional(),
  secondaryColor: hexColor.optional(),
});

/** Checksum-valid GSTIN, normalised to upper case (required on create). */
const strictGstin = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => v !== "", "GSTIN is required")
  .refine((v) => v === "" || normalizeGstin(v) !== null, "Invalid GSTIN (check the 15 characters and check digit)");

/**
 * Updates: format only here. The checksum is enforced by tenants/service updateTenant when the
 * value CHANGES, so a legacy store whose stored GSTIN fails the checksum can still re-save its
 * profile unchanged (it shows kycIncomplete instead).
 */
const businessProfile = z.object({
  legalName: str(200).optional(),
  gstin: z.string().trim().toUpperCase().regex(/^$|^[0-9A-Z]{15}$/, "Invalid GSTIN").optional(),
  email: z.union([z.literal(""), z.string().trim().email().max(254)]).optional(),
  phone: phoneField.optional(),
  website: websiteField.optional(),
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
  phone: phoneField.optional(),
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
  /** Phase 5: own_fleet (store's riders) | partner (delivery partner / courier, default). */
  method: z.enum(["own_fleet", "partner"]).optional(),
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
    // New stores: GSTIN mandatory (checksum-validated); legal name recommended.
    businessProfile: businessProfile.extend({ gstin: strictGstin }),
    slug: z.string().trim().min(2).max(80).optional(),
    status: z.enum(TENANT_STATUSES).optional(),
    admin: z
      .object({
        name: z.string().trim().min(2).max(120),
        email: z.string().trim().email().max(254),
        password: newPassword,
      })
      .optional(),
  }),
});

const reasonField = z.string().trim().max(1000);

/** Admin-editable KYC (renewing kyc.fssai lifts the FSSAI food-product hold). */
const kycPatch = z.object({
  pan: z.string().trim().toUpperCase().regex(/^$|^[A-Z]{5}[0-9]{4}[A-Z]$/, "Invalid PAN").optional(),
  legalName: str(200).optional(),
  tradeName: str(200).optional(),
  businessType: str(60).optional(),
  sellsFood: z.boolean().optional(),
  categories: z.array(objectId).max(200).optional(),
  fssai: z
    .object({
      number: z.string().trim().regex(/^\d{14}$/, "FSSAI licence number must be 14 digits"),
      expiresAt: z.coerce.date(),
      fileId: objectId.nullable().optional(),
    })
    .nullable()
    .optional(),
});

export const updateTenantSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    ...profileFields,
    status: z.enum(TENANT_STATUSES).optional(),
    /** Required with a status change (except to active). */
    reason: reasonField.optional(),
    kyc: kycPatch.optional(),
    /** Platform admin only: required to correct a locked legal name / GSTIN (min 10 chars, audit-logged). */
    identityChangeReason: z.string().trim().min(10, "Explain the correction (at least 10 characters)").max(500).optional(),
  }),
});

/** POST /tenants/:id/status (tenants.suspend). */
export const setStatusSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ status: z.enum(TENANT_STATUSES), reason: reasonField.optional() }),
});

export const accessLogSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      kind: z.enum(["read", "write"]).optional(),
    })
    .passthrough(),
});

export const accessLogByIdSchema = accessLogSchema.extend({ params: z.object({ id: objectId }) });

export const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});

/** PATCH /tenants/me — tenant staff with settings.edit; no status/slug changes; name / legal name / GSTIN locked once set. */
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
