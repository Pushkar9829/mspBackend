import mongoose from "mongoose";
import { TENANT_STATUSES } from "../../config/constants.js";

const tenantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    status: { type: String, enum: TENANT_STATUSES, default: "pending", index: true },
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
      },
    ],
    notificationPreferences: {
      email: { type: Boolean, default: true },
      inApp: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

export const Tenant = mongoose.model("Tenant", tenantSchema);
