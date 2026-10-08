import { z } from "zod";
import { AUDIENCE_TYPES, NOTIFICATION_CATEGORIES } from "./notification.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const body = (shape) => z.preprocess((v) => v ?? {}, z.object(shape).strict());

export const listSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      category: z.enum(NOTIFICATION_CATEGORIES).optional(),
    })
    .passthrough(),
});

export const idSchema = z.object({ params: z.object({ id: objectId }) });

export const announcementSchema = z.object({
  body: body({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(4000).optional().default(""),
    data: z.record(z.string(), z.any()).optional(),
    priority: z.enum(["low", "normal", "high"]).optional(),
    audienceType: z.enum(AUDIENCE_TYPES).optional(),
    userIds: z.array(objectId).max(1000).optional(),
    tenantId: objectId.nullish(),
    roleSlug: z.string().trim().min(1).max(60).optional(),
    scheduledAt: z.coerce.date().optional(),
    expiresAt: z.coerce.date().optional(),
    channels: z.object({ email: z.boolean().optional() }).strict().optional(),
  })
    .refine((b) => b.audienceType !== "user" || (b.userIds && b.userIds.length), {
      message: "userIds required for audienceType user",
    })
    .refine((b) => b.audienceType !== "role" || b.roleSlug, { message: "roleSlug required for audienceType role" })
    .refine((b) => !b.expiresAt || b.expiresAt > (b.scheduledAt || new Date()), {
      message: "expiresAt must be in the future (and after scheduledAt)",
    }),
});

const channelPatch = z.object({ inApp: z.boolean().optional(), email: z.boolean().optional(), sms: z.boolean().optional() }).strict();

export const preferencesSchema = z.object({
  body: body(Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, channelPatch.optional()]))),
});

export const unsubscribeSchema = z.object({
  body: body({ token: z.string().min(10).max(1000) }),
});
