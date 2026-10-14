import mongoose from "mongoose";

/**
 * Seller money (p4-payouts).
 *
 * SellerLedgerEntry: one immutable line per money movement between the platform and a seller.
 * `amountPaise` is signed: + the platform owes the seller, − the seller owes the platform.
 * `key` is a unique idempotency key (e.g. `sale:<orderId>`, `tcs:<orderId>`, `refund:<orderId>:<refundKey>`),
 * so every recording step can be replayed safely. Only bookkeeping fields change after insert:
 * `availableAt` (null = held until the order is final), `payoutId` (claimed by a payout run).
 */
export const SELLER_LEDGER_KINDS = [
  "sale",
  "platform_fee",
  "partner_fee",
  "gateway_fee",
  "route_fee",
  "tcs",
  "tds",
  "refund",
  "tcs_reversal",
  "tds_reversal",
  "collected_by_seller",
  "credit_repayment",
  "subscription_netting",
  "payout",
  "adjustment",
];

const sellerLedgerEntrySchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    key: { type: String, required: true },
    kind: { type: String, enum: SELLER_LEDGER_KINDS, required: true },
    amountPaise: { type: Number, required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    orderNumber: { type: String, default: "" },
    /** Order refund row key (refunds[].key) for refund / reversal lines. */
    refundRef: { type: String, default: "" },
    payoutId: { type: mongoose.Schema.Types.ObjectId, ref: "Payout", default: null },
    transferId: { type: String, default: "" },
    subscriptionInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SubscriptionInvoice", default: null },
    /** null = held (order not final yet). */
    availableAt: { type: Date, default: null },
    heldReason: { type: String, default: "" },
    memo: { type: String, default: "" },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false }
);
sellerLedgerEntrySchema.index({ key: 1 }, { unique: true });
sellerLedgerEntrySchema.index({ tenantId: 1, createdAt: -1 });
sellerLedgerEntrySchema.index({ tenantId: 1, payoutId: 1, availableAt: 1 });
sellerLedgerEntrySchema.index({ orderId: 1 });
sellerLedgerEntrySchema.index({ kind: 1, createdAt: 1 });

export const SellerLedgerEntry =
  mongoose.models.SellerLedgerEntry || mongoose.model("SellerLedgerEntry", sellerLedgerEntrySchema);

export const PAYOUT_STATUSES = ["pending_manual", "processing", "paid", "failed", "cancelled"];

const payoutTransferSchema = new mongoose.Schema(
  {
    /** "order" = release of a held Route transfer, "direct" = new transfer to the linked account. */
    type: { type: String, enum: ["order", "direct"], default: "order" },
    transferId: { type: String, default: "" },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    releasedPaise: { type: Number, default: 0 },
    reversedPaise: { type: Number, default: 0 },
    status: { type: String, enum: ["pending", "reversed", "released", "processed", "failed"], default: "pending" },
    error: { type: String, default: "" },
  },
  { _id: false }
);

const payoutSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    number: { type: String, required: true, unique: true },
    amountPaise: { type: Number, required: true },
    mode: { type: String, enum: ["route", "manual"], required: true },
    status: { type: String, enum: PAYOUT_STATUSES, default: "processing", index: true },
    entryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "SellerLedgerEntry" }],
    /** Positive paise totals of what was netted from the gross (for the statement / UI). */
    gross: {
      sales: { type: Number, default: 0 },
      creditRepayments: { type: Number, default: 0 },
      adjustments: { type: Number, default: 0 },
    },
    deductions: {
      refunds: { type: Number, default: 0 },
      cod: { type: Number, default: 0 },
      subscription: { type: Number, default: 0 },
      fees: { type: Number, default: 0 },
      tcs: { type: Number, default: 0 },
      tds: { type: Number, default: 0 },
    },
    transfers: { type: [payoutTransferSchema], default: [] },
    reference: { type: String, default: "" },
    paidAt: { type: Date, default: null },
    failureReason: { type: String, default: "" },
    cancelReason: { type: String, default: "" },
    /** Set when a transfer failed after the payout was paid and the amount went back to the balance. */
    recreditedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    history: {
      type: [
        {
          _id: false,
          at: { type: Date, default: Date.now },
          action: String,
          from: String,
          to: String,
          by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
          note: { type: String, default: "" },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);
payoutSchema.index({ tenantId: 1, createdAt: -1 });

export const Payout = mongoose.models.Payout || mongoose.model("Payout", payoutSchema);

/** `_id = PO:<FY>` (e.g. PO:2627) -> running sequence for payout numbers PO/2627/000001. */
const payoutCounterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });
export const PayoutCounter = mongoose.models.PayoutCounter || mongoose.model("PayoutCounter", payoutCounterSchema);

/** Buyer repaying credit / PO dues online (Razorpay order through the platform). */
const creditRepaymentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    razorpayOrderId: { type: String, required: true, unique: true },
    amountPaise: { type: Number, required: true },
    status: { type: String, enum: ["created", "paid"], default: "created" },
    razorpayPaymentId: { type: String, default: "" },
    paidPaise: { type: Number, default: 0 },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);
export const CreditRepayment = mongoose.models.CreditRepayment || mongoose.model("CreditRepayment", creditRepaymentSchema);
