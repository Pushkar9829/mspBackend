import { z } from "zod";
import { SELLER_LEDGER_KINDS, PAYOUT_STATUSES } from "./models.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const day = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, "Use YYYY-MM-DD");
const page = z.coerce.number().int().min(1).max(10000).optional();
const limit = z.coerce.number().int().min(1).max(200).optional();

const kindList = z
  .string()
  .trim()
  .refine((v) => v.split(",").every((k) => SELLER_LEDGER_KINDS.includes(k.trim())), "Unknown ledger kind");

export const ledgerQuerySchema = z.object({
  query: z
    .object({
      kind: kindList.optional(),
      orderId: objectId.optional(),
      payoutId: objectId.optional(),
      status: z.enum(["held", "available"]).optional(),
      from: day.optional(),
      to: day.optional(),
      page,
      limit,
    })
    .passthrough(),
});

const statusList = z
  .string()
  .trim()
  .refine((v) => v.split(",").every((s) => PAYOUT_STATUSES.includes(s.trim())), "Unknown payout status");

export const payoutListSchema = z.object({
  query: z.object({ status: statusList.optional(), tenantId: objectId.optional(), page, limit }).passthrough(),
});

export const idParamSchema = z.object({ params: z.object({ id: objectId }) });
export const tenantParamSchema = z.object({ params: z.object({ tenantId: objectId }) });

export const sellerDetailSchema = z.object({
  params: z.object({ tenantId: objectId }),
  query: z
    .object({ kind: kindList.optional(), orderId: objectId.optional(), status: z.enum(["held", "available"]).optional(), from: day.optional(), to: day.optional(), page, limit })
    .passthrough(),
});

export const sellersListSchema = z.object({
  query: z
    .object({
      q: z.string().trim().max(100).optional(),
      accountStatus: z.string().trim().max(200).optional(),
      onHold: z.enum(["true", "false"]).optional(),
      hasBalance: z.enum(["true", "false"]).optional(),
      page,
      limit,
    })
    .passthrough(),
});

export const markPaidSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      reference: z.string().trim().min(3).max(100),
      paidAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
    })
    .strict(),
});

export const cancelSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ reason: z.string().trim().min(3).max(500) }).strict(),
});

export const holdSchema = z.object({
  params: z.object({ tenantId: objectId }),
  body: z.object({ reason: z.string().trim().min(3).max(500) }).strict(),
});

export const adjustmentSchema = z.object({
  params: z.object({ tenantId: objectId }),
  body: z
    .object({
      amount: z
        .number()
        .finite()
        .refine((n) => n !== 0, "amount must not be 0")
        .refine((n) => Math.abs(n) <= 10_000_000, "too large")
        .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "at most 2 decimals"),
      reason: z.string().trim().min(3).max(500),
    })
    .strict(),
});

export const repaySchema = z.object({
  params: z.object({ tenantId: objectId }),
  body: z.object({ amount: z.number().positive().max(1e9) }).strict(),
});

export const repayVerifySchema = z.object({
  params: z.object({ tenantId: objectId }),
  body: z
    .object({
      razorpayOrderId: z.string().trim().min(1).max(100),
      razorpayPaymentId: z.string().trim().min(1).max(100),
      razorpaySignature: z.string().trim().min(1).max(200),
    })
    .strict(),
});
