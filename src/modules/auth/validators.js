import { z } from "zod";
import { normalizeGstin } from "../../utils/gstin.js";

const email = z.string().trim().email().max(254);
const password = z.string().min(8).max(100);
const phone = z.string().trim().max(20).regex(/^[0-9+\-() ]*$/, "Invalid phone");

/** Buyer business types. "retailer" is stored as "kirana", "restaurant" as "horeca". */
export const BUSINESS_TYPES = ["kirana", "horeca", "distributor", "institution", "other"];
const BUSINESS_TYPE_ALIASES = { retailer: "kirana", kirana_retailer: "kirana", restaurant: "horeca", hotel: "horeca", restaurant_horeca: "horeca" };
export const businessType = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => BUSINESS_TYPE_ALIASES[v] || v)
  .pipe(z.enum(BUSINESS_TYPES, { message: `Must be one of: ${BUSINESS_TYPES.join(", ")} (or retailer, restaurant)` }));
/** GSTIN: format, state code and check digit. "" clears it (profile updates). */
export const gstin = z
  .string()
  .trim()
  .max(20)
  .transform((v, ctx) => {
    if (v === "") return "";
    const ok = normalizeGstin(v);
    if (!ok) {
      ctx.addIssue({ code: "custom", message: "Invalid GSTIN (check the format and the last character)" });
      return z.NEVER;
    }
    return ok;
  });

export const registerSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(2).max(120),
      email,
      password,
      phone: phone.optional(),
      company: z.string().trim().max(120).optional(),
      tenantSlug: z.string().trim().max(80).optional(),
      businessType: businessType.optional(),
      gstin: gstin.optional(),
    })
    ,
});

export const loginSchema = z.object({
  body: z.object({ email, password: z.string().min(1).max(200) }),
});

export const refreshSchema = z.object({
  body: z.object({ refreshToken: z.string().max(2000).optional() }),
});

export const logoutSchema = refreshSchema;

export const forgotSchema = z.object({
  body: z.object({ email }),
});

export const resetSchema = z.object({
  body: z.object({ token: z.string().min(10).max(200), password }),
});

export const verifyEmailSchema = z.object({
  body: z.object({ token: z.string().min(10).max(200) }),
});

export const resendVerificationSchema = z.object({
  body: z.object({ email: email.optional() }),
});

const location = z
  .object({
    city: z.string().max(80).optional(),
    state: z.string().max(80).optional(),
    postalCode: z.string().max(12).optional(),
    country: z.string().max(2).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  ;

export const profileSchema = z
  .object({
    company: z.string().max(120).optional(),
    gstin: gstin.optional(),
    businessType: businessType.optional(),
    addressLine1: z.string().max(200).optional(),
    preferredSizes: z.array(z.string().max(40)).max(20).optional(),
    location: location.optional(),
  })
  ;

export const updateMeSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(2).max(120).optional(),
      phone: phone.optional(),
      profile: profileSchema.optional(),
      /** Shortcuts for profile.businessType / profile.gstin. */
      businessType: businessType.optional(),
      gstin: gstin.optional(),
    })
    ,
});

export const changePasswordSchema = z.object({
  body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: password }),
});

export const deleteMeSchema = z.object({
  body: z.object({ password: z.string().min(1).max(200), confirm: z.literal("DELETE").optional() }),
});
