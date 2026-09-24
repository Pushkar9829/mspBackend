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
