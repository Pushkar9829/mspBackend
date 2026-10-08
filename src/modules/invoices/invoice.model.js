import mongoose from "mongoose";

const invoiceLineSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["item", "fee"], default: "item" },
    description: String,
    sku: String,
    hsn: String,
    qty: Number,
    unitPrice: Number,
    grossAmount: Number,
    discount: { type: Number, default: 0 },
    taxableValue: Number,
    taxRate: Number,
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    tax: Number,
    total: Number,
  },
  { _id: false }
);

const partySchema = new mongoose.Schema(
  {
    name: String,
    legalName: String,
    company: String,
    gstin: String,
    state: String,
    address: String,
    email: String,
    phone: String,
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, unique: true },
    orderNumber: String,
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    financialYear: { type: String, required: true },
    sequence: { type: Number, required: true },
    issuedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ["issued", "cancelled"], default: "issued" },
    seller: partySchema,
    buyer: partySchema,
    shipTo: partySchema,
    placeOfSupply: String,
    supplyType: { type: String, enum: ["intra", "inter"], default: "intra" },
    /** Seller or buyer state was missing: IGST was charged and the invoice needs review. */
    placeOfSupplyUnknown: { type: Boolean, default: false },
    paymentMethod: String,
    poNumber: String,
    couponCode: String,
    lines: [invoiceLineSchema],
    totals: {
      grossAmount: Number,
      discount: Number,
      taxableValue: Number,
      cgst: Number,
      sgst: Number,
      igst: Number,
      tax: Number,
      grandTotal: Number,
    },
  },
  { timestamps: true }
);

invoiceSchema.index({ tenantId: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ tenantId: 1, financialYear: 1, sequence: 1 }, { unique: true, name: "invoice_sequence" });

const counterSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
  financialYear: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
counterSchema.index({ tenantId: 1, financialYear: 1 }, { unique: true });

export const Invoice = mongoose.model("Invoice", invoiceSchema);

/** GST credit note issued against an invoice when an order is refunded (own number series). */
const creditNoteSchema = new mongoose.Schema(
  {
    creditNoteNumber: { type: String, required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true },
    invoiceNumber: String,
    orderNumber: String,
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    /** One credit note per refund intent (order refund key). */
    reason: { type: String, default: "" },
    refundKey: { type: String, required: true },
    financialYear: { type: String, required: true },
    sequence: { type: Number, required: true },
    issuedAt: { type: Date, default: Date.now },
    seller: partySchema,
    buyer: partySchema,
    placeOfSupply: String,
    supplyType: { type: String, enum: ["intra", "inter"], default: "intra" },
    lines: [invoiceLineSchema],
    totals: {
      grossAmount: Number,
      discount: Number,
      taxableValue: Number,
      cgst: Number,
      sgst: Number,
      igst: Number,
      tax: Number,
      grandTotal: Number,
    },
  },
  { timestamps: true }
);
creditNoteSchema.index({ tenantId: 1, creditNoteNumber: 1 }, { unique: true });
creditNoteSchema.index({ tenantId: 1, financialYear: 1, sequence: 1 }, { unique: true });
creditNoteSchema.index({ orderId: 1, refundKey: 1 }, { unique: true });

export const CreditNote = mongoose.model("CreditNote", creditNoteSchema);
export const InvoiceCounter = mongoose.model("InvoiceCounter", counterSchema);
