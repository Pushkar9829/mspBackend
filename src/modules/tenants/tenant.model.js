import mongoose from "mongoose";
import { TENANT_STATUSES } from "../../config/constants.js";

export const KYC_DOCUMENT_TYPES = ["gst_certificate", "pan_card", "cancelled_cheque", "fssai", "other"];

const addressFields = {
  addressLine1: { type: String, default: "" },
  addressLine2: { type: String, default: "" },
  city: { type: String, default: "" },
  state: { type: String, default: "" },
  postalCode: { type: String, default: "" },
  country: { type: String, default: "IN" },
};

const fssaiSchema = new mongoose.Schema(
  {
    number: { type: String, default: "" },
    expiresAt: { type: Date, default: null },
    /** PrivateFile id of the licence document. */
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: "PrivateFile", default: null },
  },
  { _id: false }
);

/** Long-term record of every operational status change (no TTL, never pruned). */
const statusHistorySchema = new mongoose.Schema(
  {
    from: { type: String, default: null },
    to: { type: String, required: true },
    reason: { type: String, default: "" },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const tenantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    status: { type: String, enum: TENANT_STATUSES, default: "pending", index: true },
    /** Reason given for the current status (pause / suspension / archive), shown to the seller. */
    statusReason: { type: String, default: "" },
    statusChangedAt: { type: Date, default: null },
    statusHistory: { type: [statusHistorySchema], default: [] },
    /** Platform-admin corrections of the locked identity (legal name / GSTIN), with the reason. */
    identityChanges: {
      type: [
        new mongoose.Schema(
          {
            at: { type: Date, default: Date.now },
            by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
            reason: { type: String, default: "" },
            from: { legalName: { type: String, default: "" }, gstin: { type: String, default: "" } },
            to: { legalName: { type: String, default: "" }, gstin: { type: String, default: "" } },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    /** Seller application this store was created from (self sign-up). */
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "SellerApplication", default: null },
    /** Verified seller identity / KYC (copied from the approved application; admin-editable). */
    kyc: {
      pan: { type: String, default: "" },
      gstin: { type: String, default: "" },
      legalName: { type: String, default: "" },
      tradeName: { type: String, default: "" },
      businessType: { type: String, default: "" },
      registeredAddress: addressFields,
      bank: {
        holderName: { type: String, default: "" },
        accountLast4: { type: String, default: "" },
        /** Encrypted account number (when the application stored one) ... */
        accountNumberEnc: { type: String, default: "" },
        /** ... or a reference to where the full number lives (e.g. "sellerApplication:<id>"). */
        accountRef: { type: String, default: "" },
        /** Hash of the full account number (from the application) for duplicate-account checks. Never returned. */
        accountHash: { type: String, default: "", index: true },
        ifsc: { type: String, default: "" },
        verified: { type: Boolean, default: false },
      },
      fssai: { type: fssaiSchema, default: null },
      documents: [
        {
          _id: false,
          type: { type: String, enum: KYC_DOCUMENT_TYPES, default: "other" },
          fileId: { type: mongoose.Schema.Types.ObjectId, ref: "PrivateFile" },
        },
      ],
      sellsFood: { type: Boolean, default: false },
      categories: [{ type: mongoose.Schema.Types.ObjectId, ref: "Category" }],
      verifiedAt: { type: Date, default: null },
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    /** Versioned seller terms acceptances. */
    termsAcceptance: [
      {
        _id: false,
        version: { type: String, default: "" },
        acceptedAt: { type: Date, default: Date.now },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        ip: { type: String, default: "" },
      },
    ],
    /** Compliance job bookkeeping (FSSAI expiry reminders / food-product hold). */
    compliance: {
      fssaiReminders: [{ _id: false, days: Number, expiresAt: Date, sentAt: Date }],
      /** Set while the store's food products are hidden because the FSSAI licence expired. */
      fssaiHoldAt: { type: Date, default: null },
    },
    branding: {
      logo: { type: String, default: "" },
      primaryColor: { type: String, default: "#322FBC" },
      secondaryColor: { type: String, default: "#8B8AAE" },
    },
    businessProfile: {
      legalName: { type: String, default: "" },
      gstin: { type: String, default: "" },
      email: { type: String, default: "" },
      phone: { type: String, default: "" },
      website: { type: String, default: "" },
    },
    taxSettings: {
      defaultTaxRate: { type: Number, default: 0 },
      currency: { type: String, default: "INR" },
    },
    orderRules: {
      minOrderValue: { type: Number, default: 0 },
      allowBackorder: { type: Boolean, default: false },
    },
    pickupAddress: {
      label: { type: String, default: "Store pickup" },
      contactName: { type: String, default: "" },
      phone: { type: String, default: "" },
      addressLine1: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      postalCode: { type: String, default: "" },
      country: { type: String, default: "IN" },
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      placeId: { type: String, default: "" },
      formatted: { type: String, default: "" },
    },
    deliveryZones: [
      {
        name: { type: String, required: true },
        pincodes: [{ type: String }],
        radiusKm: { type: Number, default: null },
        center: {
          latitude: Number,
          longitude: Number,
        },
        etaDaysMin: { type: Number, default: 2 },
        etaDaysMax: { type: Number, default: 7 },
        deliveryFee: { type: Number, default: 0 },
        /** Phase 5: own_fleet = the store's own riders deliver here; partner = delivery partner / courier. */
        method: { type: String, enum: ["own_fleet", "partner"], default: "partner" },
      },
    ],
    notificationPreferences: {
      email: { type: Boolean, default: true },
      inApp: { type: Boolean, default: true },
    },
    /** Shiprocket pickup nickname once addpickup has succeeded for this store. */
    shiprocketPickup: { type: String, default: "" },
    /** Seller payouts (p4-payouts): Razorpay Route linked account + payout hold. */
    payout: {
      razorpayAccountId: { type: String, default: "" },
      stakeholderId: { type: String, default: "" },
      productId: { type: String, default: "" },
      bankLinkedAt: { type: Date, default: null },
      status: {
        type: String,
        enum: ["not_created", "created", "under_review", "needs_clarification", "activated", "suspended", "failed"],
        default: "not_created",
      },
      requirements: { type: [mongoose.Schema.Types.Mixed], default: [] },
      lastError: { type: String, default: "" },
      activatedAt: { type: Date, default: null },
      syncedAt: { type: Date, default: null },
      onHold: {
        type: new mongoose.Schema(
          {
            reason: { type: String, default: "" },
            by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
            at: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
        default: null,
      },
      lastSettlement: { type: mongoose.Schema.Types.Mixed, default: null },
    },
  },
  { timestamps: true }
);

tenantSchema.index({ "kyc.fssai.expiresAt": 1 }, { partialFilterExpression: { "kyc.fssai.expiresAt": { $type: "date" } } });
tenantSchema.index({ applicationId: 1 }, { partialFilterExpression: { applicationId: { $type: "objectId" } } });

export const Tenant = mongoose.model("Tenant", tenantSchema);
