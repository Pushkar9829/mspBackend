import { z } from "zod";
import { CONVERSATION_TYPES, CONVERSATION_STATUSES } from "../../config/constants.js";
import { isSafeMediaUrl } from "../cms/sanitize.js";

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const idParams = z.object({ id: objectId });
const body = (shape) => z.preprocess((v) => v ?? {}, z.object(shape).strict());

export const listSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    status: z.enum(CONVERSATION_STATUSES).optional(),
    type: z.enum(CONVERSATION_TYPES).optional(),
    queue: z.enum(["unassigned", "mine", "waiting", "escalated", "all"]).optional(),
    q: z.string().max(100).optional(),
  }).passthrough(),
});

export const startSchema = z.object({
  body: body({
    tenantId: objectId.optional(),
    orderId: objectId.optional(),
    productId: objectId.optional(),
    type: z.enum(CONVERSATION_TYPES).optional(),
    subject: z.string().max(200).optional(),
    message: z.string().max(4000).optional(),
  }),
});

export const messagesListSchema = z.object({
  params: idParams,
  query: z.object({
    before: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    envelope: z.enum(["0", "1", "true", "false"]).optional(),
  }).passthrough(),
});

export const postMessageSchema = z.object({
  params: idParams,
  body: body({
    body: z.string().max(4000).optional().default(""),
    attachments: z
      .array(z.string().trim().max(1000).refine(isSafeMediaUrl, "Attachment must be an http(s) URL or an /uploads/ path"))
      .max(10)
      .optional()
      .default([]),
    internal: z.boolean().optional().default(false),
  }).refine((b) => b.body.trim() || b.attachments.length, { message: "Message body or attachment required" }),
});

export const assignSchema = z.object({
  params: idParams,
  body: body({ assigneeId: objectId.nullish() }),
});

export const idOnlySchema = z.object({ params: idParams });

export const macroSchema = z.object({
  body: body({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(4000),
  }),
});

export const macroIdSchema = z.object({ params: z.object({ macroId: objectId }) });
