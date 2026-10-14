import { z } from "zod";
import { PLAN_LIMIT_KEYS, PLAN_FEATURE_KEYS, PLAN_INTERVALS } from "./plan.model.js";
import { SUBSCRIPTION_STATUSES, BILLING_MODES } from "./subscription.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const money = z.number().finite().min(0).max(10_000_000);
const limit = z.number().int().min(-1).max(10_000_000);

const limits = z.object(Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, limit.optional()]))).strict();
const features = z.object(Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, z.boolean().optional()]))).strict();
const intervalPrices = z.object({ monthly: money.nullable().optional(), yearly: money.nullable().optional() }).strict();

const planFields = {
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(2000),
  priceInr: money,
  interval: z.enum(PLAN_INTERVALS),
  intervalPrices,
  limits,
  features,
  isPublic: z.boolean(),
  sortOrder: z.number().int().min(-10_000).max(10_000),
  status: z.enum(["active", "archived"]),
};

export const createPlanSchema = z.object({
  body: z
    .object({
      code: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, "2-40 lowercase letters, digits, - or _"),
      ...planFields,
      description: planFields.description.optional().default(""),
      interval: planFields.interval.optional().default("monthly"),
      intervalPrices: intervalPrices.optional(),
      limits: limits.optional().default({}),
      features: features.optional().default({}),
      isPublic: z.boolean().optional().default(true),
      sortOrder: planFields.sortOrder.optional().default(0),
      status: planFields.status.optional().default("active"),
    })
    .strict(),
});

export const updatePlanSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object(Object.fromEntries(Object.entries(planFields).map(([k, v]) => [k, v.optional()])))
    .strict()
    .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" }),
});

export const idParamSchema = z.object({ params: z.object({ id: objectId }) });

export const listPlansSchema = z.object({ query: z.object({ status: z.enum(["active", "archived"]).optional() }).passthrough() });

export const choosePlanSchema = z.object({
  body: z.object({ planId: objectId, interval: z.enum(PLAN_INTERVALS).optional() }).strict(),
});

export const payInvoiceSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ method: z.enum(["order", "link"]).optional().default("order") }).strict().optional().default({ method: "order" }),
});

export const verifyInvoiceSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      razorpayOrderId: z.string().trim().min(1).max(100),
      razorpayPaymentId: z.string().trim().min(1).max(100),
      razorpaySignature: z.string().trim().min(1).max(200),
    })
    .strict(),
});

export const verifyAutopaySchema = z.object({
  body: z
    .object({
      razorpaySubscriptionId: z.string().trim().min(1).max(100),
      razorpayPaymentId: z.string().trim().min(1).max(100),
      razorpaySignature: z.string().trim().min(1).max(200),
    })
    .strict(),
});

export const listInvoicesSchema = z.object({
  query: z
    .object({
      status: z.string().trim().optional(),
      tenantId: objectId.optional(),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    })
    .passthrough(),
});

export const listSubscriptionsSchema = z.object({
  query: z
    .object({
      status: z
        .string()
        .trim()
        .optional()
        .refine((v) => !v || v.split(",").every((s) => SUBSCRIPTION_STATUSES.includes(s.trim())), { message: "Invalid status" }),
      billingMode: z.enum(BILLING_MODES).optional(),
      planId: objectId.optional(),
      q: z.string().trim().max(100).optional(),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    })
    .passthrough(),
});

const reason = z.string().trim().min(3).max(500);

export const adminPlanSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      planId: objectId,
      interval: z.enum(PLAN_INTERVALS).optional(),
      /** now = apply now (pro-rated invoice unless prorate:false); renewal = at the next renewal. */
      when: z.enum(["now", "renewal"]).optional().default("now"),
      prorate: z.boolean().optional().default(true),
      reason: z.string().trim().max(500).optional(),
    })
    .strict(),
});

export const billingModeSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ billingMode: z.enum(BILLING_MODES), reason: z.string().trim().max(500).optional() }).strict(),
});

export const extendGraceSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ days: z.number().int().min(1).max(90), reason }).strict(),
});

export const compSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ reason, planId: objectId.optional(), interval: z.enum(PLAN_INTERVALS).optional() }).strict(),
});

export const discountSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      /** percent / amount: off the next `cycles` invoices; credit: INR added to the store's credit; none: remove discount. */
      type: z.enum(["percent", "amount", "credit", "none"]),
      value: z.number().finite().min(0).max(10_000_000).optional().default(0),
      cycles: z.number().int().min(1).max(60).optional(),
      reason: z.string().trim().max(500).optional(),
    })
    .strict()
    .superRefine((b, ctx) => {
      if (b.type === "percent" && !(b.value > 0 && b.value <= 100)) ctx.addIssue({ code: "custom", path: ["value"], message: "1-100" });
      if ((b.type === "amount" || b.type === "credit") && !(b.value > 0)) ctx.addIssue({ code: "custom", path: ["value"], message: "Must be more than 0" });
    }),
});

export const generateInvoiceSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      kind: z.enum(["next", "custom"]).optional().default("next"),
      lines: z
        .array(
          z
            .object({
              description: z.string().trim().min(2).max(200),
              amount: z.number().finite().min(-10_000_000).max(10_000_000),
              sac: z.string().trim().regex(/^[0-9]{4,8}$/).optional(),
            })
            .strict()
        )
        .min(1)
        .max(20)
        .optional(),
      dueAt: z.coerce.date().optional(),
      note: z.string().trim().max(500).optional(),
    })
    .strict()
    .refine((b) => b.kind !== "custom" || (b.lines && b.lines.length), { message: "Lines are required for a custom invoice", path: ["lines"] }),
});

export const markPaidSchema = z.object({
  params: z.object({ invoiceId: objectId }),
  body: z
    .object({
      reference: z.string().trim().min(3).max(200),
      mode: z.enum(["bank_transfer", "cheque", "upi", "cash", "other"]).optional().default("bank_transfer"),
      paidAt: z.coerce.date().optional(),
    })
    .strict(),
});

export const voidInvoiceSchema = z.object({
  params: z.object({ invoiceId: objectId }),
  body: z.object({ reason }).strict(),
});

export const invoiceParamSchema = z.object({ params: z.object({ invoiceId: objectId }) });
