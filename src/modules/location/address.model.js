import mongoose from "mongoose";
import { normalizeIndianState } from "./pincode.js";

/** A user's saved address (user-level; not tied to a tenant). */
const addressSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    label: { type: String, default: "Shipping", maxlength: 60 },
    contactName: { type: String, required: true, maxlength: 120 },
    phone: { type: String, required: true, maxlength: 20 },
    addressLine1: { type: String, required: true, maxlength: 300 },
    addressLine2: { type: String, default: "", maxlength: 300 },
    city: { type: String, required: true, maxlength: 100 },
    /** Full state / UT name ("Delhi"); normalised on write from a name, alias or code ("DL"). */
    state: { type: String, required: true, maxlength: 100 },
    /** ISO 3166-2:IN code without "IN-" ("DL"), or null when the state is not recognised. */
    stateCode: { type: String, default: null },
    postalCode: { type: String, required: true, maxlength: 12 },
    country: { type: String, default: "IN", maxlength: 2 },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    placeId: { type: String, default: "" },
    /** True when the coordinates came from the offline stub geocoder (not a real geocode). */
    geoApproximate: { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

addressSchema.pre("validate", function normalizeState(next) {
  if (this.isModified("state") || this.stateCode === undefined) {
    const { state, stateCode } = normalizeIndianState(this.state);
    if (state) this.state = state;
    this.stateCode = stateCode;
  }
  next();
});

addressSchema.index({ userId: 1, isDefault: -1, createdAt: -1 });
// At most one default address per user.
addressSchema.index(
  { userId: 1 },
  { name: "one_default_per_user", unique: true, partialFilterExpression: { isDefault: true } }
);

export const MAX_ADDRESSES_PER_USER = 50;
export const Address = mongoose.model("Address", addressSchema);
