import mongoose from "mongoose";

const addressSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    label: { type: String, default: "Shipping" },
    contactName: { type: String, required: true },
    phone: { type: String, required: true },
    addressLine1: { type: String, required: true },
    addressLine2: { type: String, default: "" },
    city: { type: String, required: true },
    state: { type: String, required: true },
    postalCode: { type: String, required: true },
    country: { type: String, default: "IN" },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    placeId: { type: String, default: "" },
    isDefault: { type: Boolean, default: false },
    serviceability: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

addressSchema.index({ userId: 1, isDefault: 1 });

export const Address = mongoose.model("Address", addressSchema);
