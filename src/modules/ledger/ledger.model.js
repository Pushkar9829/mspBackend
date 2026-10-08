import mongoose from "mongoose";

/**
 * Credit-terms ledger, one account per (buyer, store). Money is integer paise internally
 * (`*Paise`); the rupee fields are rounded mirrors kept for existing API consumers.
 * `balancePaise` is the unused part of the buyer's credit line with that store: order debits
 * reduce it, payments received and reversals restore it up to `creditLimitPaise`; anything paid
 * beyond the dues goes to `advancePaise`. Derived (see service.presentLedger):
 *   outstanding = max(0, creditLimit - balance), available = clamp(balance, 0, creditLimit),
 *   advance = advancePaise (+ any legacy balance above the limit).
 */
export const LEDGER_ENTRY_KINDS = ["opening", "order", "reversal", "payment", "adjustment", "limit"];

const ledgerEntrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerLedger", default: null },
    type: { type: String, enum: ["credit", "debit"], required: true },
    kind: { type: String, enum: LEDGER_ENTRY_KINDS, default: "adjustment" },
    amountPaise: { type: Number, default: 0 },
    balanceAfterPaise: { type: Number, default: 0 },
    /** Part of this entry that went to (credit) or came from (debit) the advance balance. */
    advanceDeltaPaise: { type: Number, default: 0 },
    advanceAfterPaise: { type: Number, default: 0 },
    /** Dues after this entry (credit limit - balance, never below 0). */
    outstandingAfterPaise: { type: Number, default: 0 },
    amount: { type: Number, required: true, min: 0 },
    balanceAfter: { type: Number, required: true },
    note: { type: String, default: "" },
    reference: { type: String, default: "" },
    /** Normalised payment reference (trimmed, upper case); unique per account for payments. */
    referenceKey: { type: String },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

ledgerEntrySchema.index({ userId: 1, tenantId: 1, createdAt: -1 });
ledgerEntrySchema.index({ tenantId: 1, createdAt: -1 });
// One debit and one reversal per order: replays become duplicate-key no-ops.
ledgerEntrySchema.index(
  { orderId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { orderId: { $type: "objectId" }, kind: { $in: ["order", "reversal"] } } }
);
// The same payment reference cannot be recorded twice on one account.
ledgerEntrySchema.index(
  { ledgerId: 1, referenceKey: 1 },
  {
    unique: true,
    partialFilterExpression: { kind: "payment", referenceKey: { $type: "string", $gt: "" } },
    name: "unique_payment_reference",
  }
);
ledgerEntrySchema.index(
  { ledgerId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { kind: "opening" }, name: "one_opening_entry" }
);

const customerLedgerSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    balancePaise: { type: Number, default: 0 },
    /** Rupee mirror of balancePaise. */
    balance: { type: Number, default: 0 },
    creditLimitPaise: { type: Number, default: 0 },
    /**
     * Money received beyond what was owed (overpayment). Shown separately as "advance"; it is
     * not extra credit. New order debits use the advance first, then the credit line.
     */
    advancePaise: { type: Number, default: 0 },
    /** Rupee mirror of advancePaise. */
    advance: { type: Number, default: 0 },
    /** Which deferred-payment methods this store allows this buyer (allowlist; default none). */
    buyerTerms: {
      creditEnabled: { type: Boolean, default: false },
      purchaseOrderEnabled: { type: Boolean, default: false },
      paymentDays: { type: Number, default: 30 },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      updatedAt: { type: Date, default: null },
    },
    openingGrantedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

customerLedgerSchema.index({ userId: 1, tenantId: 1 }, { unique: true });
customerLedgerSchema.index({ tenantId: 1, updatedAt: -1 });

export const LedgerEntry = mongoose.model("LedgerEntry", ledgerEntrySchema);
export const CustomerLedger = mongoose.model("CustomerLedger", customerLedgerSchema);
