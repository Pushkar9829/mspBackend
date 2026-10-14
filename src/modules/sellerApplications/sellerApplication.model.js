import mongoose from "mongoose";
import { SELLER_APPLICATION_STATUSES, SELLER_DOCUMENT_TYPES } from "../../config/constants.js";

const { ObjectId } = mongoose.Schema.Types;

const addressSchema = new mongoose.Schema(
  {
    contactName: { type: String, default: "" },
    phone: { type: String, default: "" },
    addressLine1: { type: String, default: "" },
    addressLine2: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    /** ISO 3166-2:IN code (MH, DL, ...) derived from `state`; null when unknown. */
    stateCode: { type: String, default: null },
    postalCode: { type: String, default: "" },
    country: { type: String, default: "IN" },
  },
  { _id: false }
);

const historySchema = new mongoose.Schema(
  {
    from: { type: String, default: null },
    to: { type: String, required: true },
    by: { type: ObjectId, ref: "User", default: null },
    at: { type: Date, default: Date.now },
    note: { type: String, default: "" },
  },
  { _id: false }
);

/**
 * A seller's sign-up application (phase 2). One user can have several over time (a rejected one
 * is kept for history; reapply clones it into a new draft). "Current" = the user's latest.
 * Bank account numbers are stored AES-256-GCM encrypted (`bank.accountNumberEnc`, never returned
 * to the applicant) plus `accountLast4` and a keyed hash for duplicate detection.
 */
const sellerApplicationSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: "User", required: true, index: true },
    email: { type: String, default: "", lowercase: true, trim: true },
    phone: { type: String, default: "", trim: true },
    status: { type: String, enum: SELLER_APPLICATION_STATUSES, default: "draft", index: true },
    business: {
      legalName: { type: String, default: "" },
      tradeName: { type: String, default: "" },
      businessType: { type: String, default: "" },
      gstin: { type: String, default: "", index: true },
      pan: { type: String, default: "", index: true },
      yearStarted: { type: Number, default: null },
    },
    registeredAddress: { type: addressSchema, default: () => ({}) },
    pickupAddress: { type: addressSchema, default: () => ({}) },
    bank: {
      holderName: { type: String, default: "" },
      accountNumberEnc: { type: String, default: "" },
      accountLast4: { type: String, default: "" },
      accountHash: { type: String, default: "", index: true },
      ifsc: { type: String, default: "" },
    },
    fssai: {
      number: { type: String, default: "" },
      expiresAt: { type: Date, default: null },
    },
    sellsFood: { type: Boolean, default: false },
    categories: [{ type: ObjectId, ref: "Category" }],
    documents: [
      {
        _id: false,
        type: { type: String, enum: SELLER_DOCUMENT_TYPES, required: true },
        fileId: { type: ObjectId, ref: "PrivateFile", required: true },
      },
    ],
    termsVersion: { type: String, default: "" },
    /** Phase 3 billing: subscription plan chosen at sign-up (optional; default plan on approval). */
    planId: { type: ObjectId, ref: "Plan", default: null },
    planInterval: { type: String, enum: ["monthly", "yearly", null], default: null },
    termsAcceptedAt: { type: Date, default: null },
    termsAcceptedIp: { type: String, default: "" },
    checks: {
      ranAt: { type: Date, default: null },
      gstinValid: { type: Boolean, default: null },
      panMatchesGstin: { type: Boolean, default: null },
      stateMatches: { type: Boolean, default: null },
      gstinStateCode: { type: String, default: null },
      pickupStateCode: { type: String, default: null },
      duplicates: [
        {
          _id: false,
          /** gstin | pan | bank | phone | email */
          field: String,
          /** tenant | application */
          matchType: String,
          ref: ObjectId,
          refStatus: String,
          label: String,
        },
      ],
    },
    reviewerNotes: [
      {
        text: { type: String, required: true },
        by: { type: ObjectId, ref: "User", default: null },
        at: { type: Date, default: Date.now },
      },
    ],
    moreInfoRequest: {
      message: { type: String, default: "" },
      at: { type: Date, default: null },
      by: { type: ObjectId, ref: "User", default: null },
    },
    rejection: {
      reason: { type: String, default: "" },
      at: { type: Date, default: null },
      by: { type: ObjectId, ref: "User", default: null },
    },
    reapplyAfter: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    reviewStartedAt: { type: Date, default: null },
    reviewerId: { type: ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: ObjectId, ref: "User", default: null },
    tenantId: { type: ObjectId, ref: "Tenant", default: null },
    /** Set on a reapply draft: the rejected application it was cloned from. */
    previousApplicationId: { type: ObjectId, ref: "SellerApplication", default: null },
    /** Set on a rejected application once it was cloned by reapply (blocks a second reapply). */
    supersededBy: { type: ObjectId, ref: "SellerApplication", default: null },
    history: [historySchema],
  },
  { timestamps: true }
);

sellerApplicationSchema.index({ userId: 1, createdAt: -1 });
sellerApplicationSchema.index({ status: 1, submittedAt: -1 });
sellerApplicationSchema.index({ phone: 1 });

export const SellerApplication = mongoose.model("SellerApplication", sellerApplicationSchema);
