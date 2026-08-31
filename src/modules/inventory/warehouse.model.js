import mongoose from "mongoose";

const warehouseSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    name: { type: String, required: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    addressLine1: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    postalCode: { type: String, default: "" },
    country: { type: String, default: "IN" },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

warehouseSchema.index({ tenantId: 1, code: 1 }, { unique: true });

export const Warehouse = mongoose.model("Warehouse", warehouseSchema);
