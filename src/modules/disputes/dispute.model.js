import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

/**
 * Phase 6: a buyer's dispute about the outcome of ONE return (order.returns[]): the seller
 * rejected it, the pickup failed, or the seller rejected units at the quality check. One dispute
 * per return (`returnKey` unique). Statuses:
 *   open            just opened, waiting for the seller's reply (sellerRespondBy)
 *   awaiting_seller the platform asked the seller for more information (respondBy)
 *   awaiting_buyer  the platform asked the buyer for more information (respondBy)
 *   under_review    in the platform's review queue
 *   resolved_refund | resolved_reopened | rejected | withdrawn   (closed)
 */
export const DISPUTE_STATUSES = [
  "open",
  "awaiting_seller",
  "awaiting_buyer",
  "under_review",
  "resolved_refund",
  "resolved_reopened",
  "rejected",
  "withdrawn",
];
export const OPEN_DISPUTE_STATUSES = ["open", "awaiting_seller", "awaiting_buyer", "under_review"];
export const CLOSED_DISPUTE_STATUSES = ["resolved_refund", "resolved_reopened", "rejected", "withdrawn"];
/** Outcomes that count as "lost" by the seller on the scorecard. */
export const SELLER_LOST_STATUSES = ["resolved_refund", "resolved_reopened"];
export const DISPUTE_KINDS = ["return_rejected", "qc_rejected", "pickup_failed"];

export const DISPUTE_STATUS_LABELS = {
  open: "Waiting for the seller",
  awaiting_seller: "More information requested from the seller",
  awaiting_buyer: "More information requested from you",
  under_review: "Under review by the platform",
  resolved_refund: "Resolved: refund",
  resolved_reopened: "Resolved: return reopened",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};
export const DISPUTE_KIND_LABELS = {
  return_rejected: "Return rejected by the seller",
  qc_rejected: "Items rejected at the seller's quality check",
  pickup_failed: "Return pickup failed",
};

const messageSchema = new mongoose.Schema(
  {
    from: { type: String, enum: ["buyer", "seller", "admin", "system"], required: true },
    userId: { type: ObjectId, ref: "User", default: null },
    /** message | info_request (admin asks `to` for more) | decision | status */
    kind: { type: String, enum: ["message", "info_request", "decision", "status"], default: "message" },
    to: { type: String, enum: ["", "buyer", "seller", "both"], default: "" },
    text: { type: String, default: "", maxlength: 4000 },
    fileIds: { type: [ObjectId], default: [] },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const disputeSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    tenantId: { type: ObjectId, ref: "Tenant", required: true, index: true },
    orderId: { type: ObjectId, ref: "Order", required: true, index: true },
    orderNumber: { type: String, default: "" },
    returnId: { type: ObjectId, required: true },
    /** String(returnId): one dispute per return. */
    returnKey: { type: String, required: true, unique: true },
    buyerId: { type: ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: DISPUTE_KINDS, required: true },
    status: { type: String, enum: DISPUTE_STATUSES, default: "open", index: true },
    /** Buyer's summary (first message). */
    summary: { type: String, default: "", maxlength: 2000 },
    /** Units in dispute and their refund value (same rules as a return of them). */
    items: {
      type: [{ _id: false, itemId: ObjectId, name: String, qty: Number, amount: Number }],
      default: [],
    },
    claimAmount: { type: Number, default: 0 },
    messages: { type: [messageSchema], default: [] },
    /** Whose reply the dispute is waiting for, and until when. */
    awaiting: { type: String, enum: ["", "seller", "buyer", "admin"], default: "seller" },
    respondBy: { type: Date, default: null },
    sellerRespondBy: { type: Date, default: null },
    sellerRespondedAt: { type: Date, default: null },
    /** The seller (or the party asked for info) did not reply in time; moved to review anyway. */
    timedOut: { type: Boolean, default: false },
    reviewAt: { type: Date, default: null },
    decision: {
      action: { type: String, enum: ["", "refund", "reopen", "reject"], default: "" },
      amount: { type: Number, default: 0 },
      reason: { type: String, default: "" },
      by: { type: ObjectId, ref: "User", default: null },
      at: { type: Date, default: null },
      refundKey: { type: String, default: "" },
      refundMethod: { type: String, default: "" },
      newReturnId: { type: ObjectId, default: null },
    },
    history: {
      type: [{ _id: false, status: String, at: { type: Date, default: Date.now }, by: { type: ObjectId, default: null }, note: { type: String, default: "" } }],
      default: [],
    },
    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

disputeSchema.index({ status: 1, respondBy: 1 });
disputeSchema.index({ tenantId: 1, createdAt: -1 });
disputeSchema.index({ status: 1, createdAt: 1 });

export const Dispute = mongoose.models.Dispute || mongoose.model("Dispute", disputeSchema);

const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });
export const DisputeCounter = mongoose.models.DisputeCounter || mongoose.model("DisputeCounter", counterSchema);
