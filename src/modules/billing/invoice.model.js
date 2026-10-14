import mongoose from "mongoose";
import { planSnapshotSchema } from "./subscription.model.js";

const { ObjectId } = mongoose.Schema.Types;

export const SUBSCRIPTION_INVOICE_STATUSES = ["draft", "issued", "paid", "void"];
/** first = first paid period; renewal = next period; upgrade = pro-rated plan change; custom = admin lines only. */
export const SUBSCRIPTION_INVOICE_KINDS = ["first", "renewal", "upgrade", "custom"];

const lineSchema = new mongoose.Schema(
  {
    description: { type: String, required: true },
    sac: { type: String, default: "" },
    /** GST-exclusive amount (negative for discounts / credits). */
    amount: { type: Number, required: true },
  },
  { _id: false }
);

const partySchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    legalName: { type: String, default: "" },
    gstin: { type: String, default: "" },
    address: { type: String, default: "" },
    state: { type: String, default: "" },
    email: { type: String, default: "" },
  },
  { _id: false }
);

/**
 * Platform -> seller GST tax invoice for a subscription charge (platform is the supplier).
 * Numbers come from the platform series (`platform.invoicePrefix`, own counter), <= 16 chars,
 * assigned when the invoice is issued. GST is added on top of the (GST-exclusive) lines.
 */
const subscriptionInvoiceSchema = new mongoose.Schema(
  {
    tenantId: { type: ObjectId, ref: "Tenant", required: true, index: true },
    subscriptionId: { type: ObjectId, ref: "TenantSubscription", required: true, index: true },
    number: { type: String, default: null },
    financialYear: { type: String, default: "" },
    sequence: { type: Number, default: null },
    kind: { type: String, enum: SUBSCRIPTION_INVOICE_KINDS, default: "renewal" },
    /** Plan this invoice buys (first / renewal / upgrade). */
    planId: { type: ObjectId, ref: "Plan", default: null },
    planSnapshot: { type: planSnapshotSchema, default: null },
    /** Upgrade that restarts the billing period at payment (interval change). */
    restartPeriod: { type: Boolean, default: false },
    period: {
      start: { type: Date, default: null },
      end: { type: Date, default: null },
    },
    lines: { type: [lineSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    taxRate: { type: Number, default: 18 },
    tax: {
      cgst: { type: Number, default: 0 },
      sgst: { type: Number, default: 0 },
      igst: { type: Number, default: 0 },
    },
    total: { type: Number, default: 0 },
    supplyType: { type: String, enum: ["intra", "inter"], default: "inter" },
    placeOfSupply: { type: String, default: "" },
    supplier: { type: partySchema, default: () => ({}) },
    recipient: { type: partySchema, default: () => ({}) },
    status: { type: String, enum: SUBSCRIPTION_INVOICE_STATUSES, default: "draft", index: true },
    issuedAt: { type: Date, default: null },
    dueAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    payment: {
      /** netting = paid out of the seller payout (p4-payouts). */
      method: { type: String, enum: ["razorpay", "manual", "netting", null], default: null },
      /** Manual: bank transfer UTR / cheque no. / UPI ref. Zero-amount: why nothing was charged. */
      reference: { type: String, default: "" },
      mode: { type: String, default: "" },
      razorpayPaymentId: { type: String, default: "" },
      razorpayOrderId: { type: String, default: "" },
      razorpayPaymentLinkId: { type: String, default: "" },
      razorpaySubscriptionId: { type: String, default: "" },
      shortUrl: { type: String, default: "" },
      recordedBy: { type: ObjectId, ref: "User", default: null },
    },
    /** Relative URL of the PDF (rendered on demand). */
    pdf: { type: String, default: "" },
    /** Set while a first / renewal invoice for a period is open (unique): one invoice per period. */
    periodKey: { type: String, default: undefined },
    note: { type: String, default: "" },
    /** Subscription credits / a discount cycle consumed by this invoice (given back if voided). */
    creditsApplied: { type: Number, default: 0 },
    discountApplied: { type: Boolean, default: false },
    voidReason: { type: String, default: "" },
    voidedAt: { type: Date, default: null },
    createdBy: { type: ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);
subscriptionInvoiceSchema.index({ number: 1 }, { unique: true, partialFilterExpression: { number: { $type: "string" } } });
subscriptionInvoiceSchema.index({ periodKey: 1 }, { unique: true, partialFilterExpression: { periodKey: { $type: "string" } } });
subscriptionInvoiceSchema.index(
  { "payment.razorpayPaymentId": 1 },
  { unique: true, partialFilterExpression: { "payment.razorpayPaymentId": { $gt: "" } } }
);
subscriptionInvoiceSchema.index({ "payment.razorpayOrderId": 1 }, { partialFilterExpression: { "payment.razorpayOrderId": { $gt: "" } } });
subscriptionInvoiceSchema.index({ tenantId: 1, createdAt: -1 });

export const SubscriptionInvoice =
  mongoose.models.SubscriptionInvoice || mongoose.model("SubscriptionInvoice", subscriptionInvoiceSchema);

/** Platform invoice number series (one row per financial year). */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String },
    seq: { type: Number, default: 0 },
    code: { type: String, default: "" },
  },
  { versionKey: false }
);
export const PlatformInvoiceCounter =
  mongoose.models.PlatformInvoiceCounter || mongoose.model("PlatformInvoiceCounter", counterSchema);
