import mongoose from "mongoose";

export const RECON_ITEM_TYPES = ["payment", "refund", "transfer", "reversal", "settlement"];
export const RECON_ITEM_STATUSES = ["matched", "mismatched", "missing", "unknown"];

const reconItemSchema = new mongoose.Schema(
  {
    type: { type: String, enum: RECON_ITEM_TYPES, required: true },
    /** matched | mismatched (amount differs) | missing (ours, not in Razorpay) | unknown (Razorpay, not ours). */
    status: { type: String, enum: RECON_ITEM_STATUSES, required: true },
    /** Razorpay id (pay_ / rfnd_ / trf_ / rvrsl_ / setl_). */
    entityId: { type: String, required: true },
    /** Our record: order number(s), payout number, subscription invoice number... */
    ourRef: { type: String, default: "" },
    ourKind: { type: String, default: "" },
    orderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Order" }],
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    expectedPaise: { type: Number, default: null },
    actualPaise: { type: Number, default: null },
    feePaise: { type: Number, default: 0 },
    taxPaise: { type: Number, default: 0 },
    settlementId: { type: String, default: "" },
    /** null when matched; amount_mismatch | not_in_settlement | not_found | unrecognised_type | settlement_total_mismatch. */
    problem: { type: String, default: null },
    resolved: {
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      at: { type: Date, default: null },
      note: { type: String, default: "" },
    },
  },
  { _id: true }
);

const reconciliationRunSchema = new mongoose.Schema(
  {
    /** IST settlement day "YYYY-MM-DD" (one run per day; re-running replaces its items). */
    date: { type: String, required: true, unique: true },
    status: { type: String, enum: ["running", "completed", "failed"], default: "running" },
    source: { type: String, enum: ["job", "admin", "test"], default: "admin" },
    counts: {
      matched: { type: Number, default: 0 },
      mismatched: { type: Number, default: 0 },
      missing: { type: Number, default: 0 },
      unknown: { type: Number, default: 0 },
      unresolved: { type: Number, default: 0 },
    },
    totals: {
      settledPaise: { type: Number, default: 0 },
      feesPaise: { type: Number, default: 0 },
      taxPaise: { type: Number, default: 0 },
      rows: { type: Number, default: 0 },
    },
    items: { type: [reconItemSchema], default: [] },
    error: { type: String, default: "" },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);
reconciliationRunSchema.index({ "items.entityId": 1 });
reconciliationRunSchema.index({ createdAt: -1 });

export const ReconciliationRun =
  mongoose.models.ReconciliationRun || mongoose.model("ReconciliationRun", reconciliationRunSchema);

/** One courier COD remittance (bank credit from Delhivery / Shiprocket) and how it matched orders. */
const codRemittanceRowSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, default: "" },
    awb: { type: String, default: "" },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    expected: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    difference: { type: Number, default: 0 },
    /** ok | short | excess | not_found | not_courier_cod | already_remitted */
    status: { type: String, required: true },
  },
  { _id: false }
);

const codRemittanceSchema = new mongoose.Schema(
  {
    carrier: { type: String, required: true },
    reference: { type: String, required: true },
    receivedAt: { type: Date, required: true },
    rows: { type: [codRemittanceRowSchema], default: [] },
    totals: {
      expected: { type: Number, default: 0 },
      received: { type: Number, default: 0 },
      short: { type: Number, default: 0 },
      excess: { type: Number, default: 0 },
      matchedOrders: { type: Number, default: 0 },
      flagged: { type: Number, default: 0 },
    },
    note: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);
codRemittanceSchema.index({ carrier: 1, reference: 1 }, { unique: true });
codRemittanceSchema.index({ createdAt: -1 });

export const CodRemittance = mongoose.models.CodRemittance || mongoose.model("CodRemittance", codRemittanceSchema);
