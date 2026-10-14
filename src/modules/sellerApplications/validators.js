import { z } from "zod";
import { normalizeGstin } from "../../utils/gstin.js";
import { newPassword } from "../../utils/password.js";
import { SELLER_APPLICATION_STATUSES, SELLER_DOCUMENT_TYPES } from "../../config/constants.js";

export const PAN_RX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const IFSC_RX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCOUNT_RX = /^[0-9]{9,18}$/;
export const FSSAI_RX = /^[0-9]{14}$/;
export const PIN_RX = /^[1-9][0-9]{5}$/;
export const SELLER_BUSINESS_TYPES = ["proprietorship", "partnership", "llp", "private_limited", "public_limited", "huf", "trust", "society", "other"];

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const phone = z.string().trim().max(20).regex(/^[0-9+\-() ]*$/, "Invalid phone");
const upper = (max) => z.string().trim().max(max).transform((v) => v.toUpperCase().replace(/\s+/g, ""));

/** "" clears; otherwise must match `rx` (after upper-casing / removing spaces). */
const pattern = (max, rx, message) => upper(max).refine((v) => v === "" || rx.test(v), { message });

const gstin = z
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

const address = z
  .object({
    contactName: z.string().trim().max(120).optional(),
    phone: phone.optional(),
    addressLine1: z.string().trim().max(200).optional(),
    addressLine2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(80).optional(),
    state: z.string().trim().max(80).optional(),
    postalCode: z
      .string()
      .trim()
      .max(12)
      .refine((v) => v === "" || PIN_RX.test(v), { message: "Invalid PIN code" })
      .optional(),
    country: z.literal("IN").optional(),
  })
  .strict();

const email = z.string().trim().toLowerCase().email().max(254);
const password = newPassword;

export const registerSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(2).max(120),
      email,
      password,
      phone: phone.min(10, "Phone is required"),
      /** Optional head start for the draft. */
      businessName: z.string().trim().max(160).optional(),
    })
    .strict(),
});

export const updateMeSchema = z.object({
  body: z
    .object({
      phone: phone.optional(),
      business: z
        .object({
          legalName: z.string().trim().max(160).optional(),
          tradeName: z.string().trim().max(160).optional(),
          businessType: z.union([z.enum(SELLER_BUSINESS_TYPES), z.literal("")]).optional(),
          gstin: gstin.optional(),
          pan: pattern(10, PAN_RX, "Invalid PAN (format AAAAA9999A)").optional(),
          yearStarted: z.number().int().min(1800).max(2100).nullable().optional(),
        })
        .strict()
        .optional(),
      registeredAddress: address.optional(),
      pickupAddress: address.optional(),
      bank: z
        .object({
          holderName: z.string().trim().max(120).optional(),
          /** Full number (write only). Responses carry accountLast4. "" clears. */
          accountNumber: z
            .string()
            .trim()
            .max(30)
            .transform((v) => v.replace(/\s+/g, ""))
            .refine((v) => v === "" || ACCOUNT_RX.test(v), { message: "Account number must be 9-18 digits" })
            .optional(),
          ifsc: pattern(11, IFSC_RX, "Invalid IFSC (format ABCD0123456)").optional(),
        })
        .strict()
        .optional(),
      fssai: z
        .object({
          number: pattern(14, FSSAI_RX, "FSSAI licence number must be 14 digits").optional(),
          expiresAt: z.union([z.coerce.date(), z.literal(""), z.null()]).optional(),
        })
        .strict()
        .optional(),
      sellsFood: z.boolean().optional(),
      categories: z.array(objectId).max(50).optional(),
      documents: z
        .array(z.object({ type: z.enum(SELLER_DOCUMENT_TYPES), fileId: objectId }).strict())
        .max(20)
        .optional(),
      /** Accept the seller terms: must equal the current version (GET /terms/seller/current). */
      termsVersion: z.string().trim().min(1).max(40).optional(),
      /** Subscription plan (GET /plans); null / "" clears. */
      planId: z.union([objectId, z.literal(""), z.null()]).optional(),
      planInterval: z.union([z.enum(["monthly", "yearly"]), z.literal(""), z.null()]).optional(),
    })
    .strict(),
});

export const submitSchema = z.object({
  body: z.object({ termsVersion: z.string().trim().min(1).max(40).optional() }).strict(),
});

export const idParamSchema = z.object({ params: z.object({ id: objectId }) });

export const listSchema = z.object({
  query: z
    .object({
      status: z
        .string()
        .trim()
        .optional()
        .refine((v) => !v || v.split(",").every((s) => SELLER_APPLICATION_STATUSES.includes(s.trim())), { message: "Invalid status" }),
      q: z.string().trim().max(100).optional(),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    })
    .passthrough(),
});

export const requestInfoSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ message: z.string().trim().min(3).max(2000) }).strict(),
});

export const rejectSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ reason: z.string().trim().min(3).max(2000) }).strict(),
});

export const approveSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      note: z.string().trim().max(2000).optional(),
      /** Override the applicant's plan choice (phase 3 billing). */
      planId: objectId.optional(),
      planInterval: z.enum(["monthly", "yearly"]).optional(),
    })
    .strict(),
});

export const noteSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ text: z.string().trim().min(1).max(2000) }).strict(),
});

export const startReviewSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ note: z.string().trim().max(2000).optional() }).strict().optional(),
});

export const uploadSchema = z.object({
  body: z.object({ type: z.enum(SELLER_DOCUMENT_TYPES).default("other") }).passthrough(),
});

export const fileParamSchema = z.object({ params: z.object({ fileId: objectId }) });
export const notificationParamSchema = z.object({ params: z.object({ id: objectId }) });
