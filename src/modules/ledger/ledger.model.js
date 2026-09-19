import mongoose from "mongoose";

const ledgerEntrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    type: { type: String, enum: ["credit", "debit"], required: true },
    amount: { type: Number, required: true, min: 0 },
    balanceAfter: { type: Number, required: true },
    note: { type: String, default: "" },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
  },
  { timestamps: true }
);

const customerLedgerSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    balance: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const LedgerEntry = mongoose.model("LedgerEntry", ledgerEntrySchema);
export const CustomerLedger = mongoose.model("CustomerLedger", customerLedgerSchema);
