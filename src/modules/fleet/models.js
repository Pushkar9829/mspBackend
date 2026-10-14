import mongoose from "mongoose";
import {
  RIDER_VEHICLE_TYPES,
  RIDER_ID_PROOF_TYPES,
  DELIVERY_TASK_KINDS,
  DELIVERY_TASK_STATUSES,
  DELIVERY_FAIL_REASONS,
} from "../../config/constants.js";

/**
 * Phase 5 (p5-backend): a store's own delivery fleet.
 *
 * - Rider          rider profile (one per rider User; the User holds the system `rider` role)
 * - DeliveryTask   one delivery (or return pickup) of one order, worked by one rider at a time
 * - DeliveryRun    a rider's batch of tasks for one IST day and area
 * - RiderCashEntry COD cash in a rider's hand (collected +, deposited to the store −)
 * - OtpChallenge   mobile + OTP login codes (hashed)
 */

const { ObjectId } = mongoose.Schema.Types;

const riderSchema = new mongoose.Schema(
  {
    tenantId: { type: ObjectId, ref: "Tenant", required: true, index: true },
    userId: { type: ObjectId, ref: "User", required: true, unique: true },
    name: { type: String, required: true, trim: true },
    /** Normalised "+91XXXXXXXXXX"; unique among riders (one rider account per mobile). */
    phone: { type: String, required: true },
    vehicle: {
      type: { type: String, enum: RIDER_VEHICLE_TYPES, default: "bike" },
      number: { type: String, default: "", trim: true },
    },
    /** Only the last 4 characters and a keyed hash of the ID number are stored. */
    idProof: {
      type: { type: String, enum: [...RIDER_ID_PROOF_TYPES, ""], default: "" },
      last4: { type: String, default: "" },
      numberHash: { type: String, default: "", select: false },
      fileId: { type: ObjectId, ref: "PrivateFile", default: null },
    },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    /** Optional areas (delivery zone names / PIN codes) this rider serves; empty = any. */
    zoneNames: { type: [String], default: [] },
    stats: {
      delivered: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    createdBy: { type: ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);
riderSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: "string" } } });
riderSchema.index({ tenantId: 1, status: 1, name: 1 });

const attemptSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    reason: { type: String, enum: DELIVERY_FAIL_REASONS, required: true },
    note: { type: String, default: "" },
    photoFileId: { type: ObjectId, ref: "PrivateFile", default: null },
    riderId: { type: ObjectId, ref: "Rider", default: null },
  },
  { _id: false }
);

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    from: { type: String, default: "" },
    to: { type: String, default: "" },
    by: { type: ObjectId, ref: "User", default: null },
    note: { type: String, default: "" },
  },
  { _id: false }
);

const itemCheckSchema = new mongoose.Schema(
  {
    lineId: { type: ObjectId, required: true },
    name: { type: String, default: "" },
    qty: { type: Number, default: 0 },
    okQty: { type: Number, default: 0 },
    damagedQty: { type: Number, default: 0 },
    note: { type: String, default: "" },
  },
  { _id: false }
);

const deliveryTaskSchema = new mongoose.Schema(
  {
    tenantId: { type: ObjectId, ref: "Tenant", required: true, index: true },
    orderId: { type: ObjectId, ref: "Order", required: true, index: true },
    orderNumber: { type: String, default: "" },
    kind: { type: String, enum: DELIVERY_TASK_KINDS, default: "delivery" },
    /** return_pickup only: order.returns[]._id */
    returnId: { type: ObjectId, default: null },
    riderId: { type: ObjectId, ref: "Rider", default: null, index: true },
    runId: { type: ObjectId, ref: "DeliveryRun", default: null },
    status: { type: String, enum: DELIVERY_TASK_STATUSES, default: "unassigned", index: true },
    /** Area used for grouping / runs: the matched delivery zone name, else the PIN code. */
    area: { type: String, default: "" },
    /** IST day (YYYY-MM-DD) the task is due (creation day, or the rescheduled day). */
    dueDate: { type: String, default: "" },
    attempts: { type: [attemptSchema], default: [] },
    maxAttempts: { type: Number, default: 2 },
    rescheduledFor: { type: Date, default: null },
    /**
     * Buyer delivery OTP: `hash` (HMAC, used to verify) + `cipher` (AES-GCM, so only the buyer's
     * order view can show the code while the order is out for delivery). Never returned to riders.
     */
    otp: {
      hash: { type: String, default: "", select: false },
      cipher: { type: String, default: "", select: false },
      sentAt: { type: Date, default: null },
      resends: { type: Number, default: 0 },
      attempts: { type: Number, default: 0 },
      verifiedAt: { type: Date, default: null },
    },
    cod: {
      amount: { type: Number, default: 0 },
      method: { type: String, enum: ["cash", "upi_qr", null], default: null },
      collectedAt: { type: Date, default: null },
      razorpayQrId: { type: String, default: "" },
      qrImageUrl: { type: String, default: "" },
      qrAmountPaise: { type: Number, default: 0 },
      razorpayPaymentId: { type: String, default: "" },
      paidAt: { type: Date, default: null },
    },
    proofPhotoFileId: { type: ObjectId, ref: "PrivateFile", default: null },
    itemCheck: { type: [itemCheckSchema], default: [] },
    photos: { type: [{ type: ObjectId, ref: "PrivateFile" }], default: [] },
    dropoff: {
      address: { type: String, default: "" },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      pincode: { type: String, default: "" },
    },
    buyer: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
    },
    assignedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);
// One delivery task per order; one return-pickup task per return.
deliveryTaskSchema.index({ orderId: 1, kind: 1, returnId: 1 }, { unique: true, name: "task_per_order_kind_return" });
deliveryTaskSchema.index({ tenantId: 1, status: 1, dueDate: 1 });
deliveryTaskSchema.index({ riderId: 1, status: 1, updatedAt: -1 });
deliveryTaskSchema.index({ "cod.razorpayQrId": 1 }, { partialFilterExpression: { "cod.razorpayQrId": { $type: "string", $gt: "" } } });

const deliveryRunSchema = new mongoose.Schema(
  {
    tenantId: { type: ObjectId, ref: "Tenant", required: true, index: true },
    riderId: { type: ObjectId, ref: "Rider", required: true },
    date: { type: String, required: true },
    area: { type: String, default: "" },
    taskIds: { type: [{ type: ObjectId, ref: "DeliveryTask" }], default: [] },
    status: { type: String, enum: ["open", "in_progress", "done"], default: "open" },
  },
  { timestamps: true }
);
deliveryRunSchema.index({ tenantId: 1, riderId: 1, date: 1, area: 1 }, { unique: true });
deliveryRunSchema.index({ tenantId: 1, date: 1 });

const riderCashEntrySchema = new mongoose.Schema(
  {
    tenantId: { type: ObjectId, ref: "Tenant", required: true, index: true },
    riderId: { type: ObjectId, ref: "Rider", required: true },
    kind: { type: String, enum: ["collected", "deposit", "adjustment"], required: true },
    /** Signed: collected +, deposit −, adjustment ±. Cash in hand = sum. */
    amountPaise: { type: Number, required: true },
    taskId: { type: ObjectId, ref: "DeliveryTask", default: null },
    orderId: { type: ObjectId, ref: "Order", default: null },
    orderNumber: { type: String, default: "" },
    note: { type: String, default: "" },
    by: { type: ObjectId, ref: "User", default: null },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
riderCashEntrySchema.index({ riderId: 1, at: -1 });
// A task's COD cash is collected once.
riderCashEntrySchema.index(
  { taskId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { kind: "collected", taskId: { $type: "objectId" } } }
);

const otpChallengeSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true },
    purpose: { type: String, default: "rider_login" },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    sentAt: { type: Date, default: Date.now },
    consumedAt: { type: Date, default: null },
    ip: { type: String, default: "" },
  },
  { timestamps: true }
);
otpChallengeSchema.index({ phone: 1, purpose: 1, createdAt: -1 });
// Expired challenges are removed by MongoDB a day later (kept briefly for cooldown / audit).
otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export const Rider = mongoose.models.Rider || mongoose.model("Rider", riderSchema);
export const DeliveryTask = mongoose.models.DeliveryTask || mongoose.model("DeliveryTask", deliveryTaskSchema);
export const DeliveryRun = mongoose.models.DeliveryRun || mongoose.model("DeliveryRun", deliveryRunSchema);
export const RiderCashEntry = mongoose.models.RiderCashEntry || mongoose.model("RiderCashEntry", riderCashEntrySchema);
export const OtpChallenge = mongoose.models.OtpChallenge || mongoose.model("OtpChallenge", otpChallengeSchema);

/** Statuses after which a task needs no more work. */
export const TERMINAL_TASK_STATUSES = ["delivered", "returned_to_store", "cancelled"];
