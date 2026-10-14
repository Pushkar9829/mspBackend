import mongoose from "mongoose";

const offerSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    name: { type: String, required: true },
    type: { type: String, enum: ["percent", "fixed", "flash"], default: "percent" },
    value: { type: Number, required: true },
    productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
    categoryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Category" }],
    customerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    /** all = every purchase, regular = single (non-bulk) purchases, bulk = bulk purchases only. */
    appliesTo: { type: String, enum: ["all", "regular", "bulk"], default: "all" },
    inventoryCap: { type: Number, default: null },
    inventoryUsed: { type: Number, default: 0 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    /** rejected: a platform admin turned the approval request down (reason below); the seller can edit and resubmit. */
    status: { type: String, enum: ["draft", "active", "inactive", "pending_approval", "rejected"], default: "draft" },
    rejectionReason: { type: String, default: "" },
    rejectedAt: { type: Date, default: null },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

offerSchema.index({ tenantId: 1, status: 1, startsAt: 1, endsAt: 1 });

export const Offer = mongoose.model("Offer", offerSchema);
