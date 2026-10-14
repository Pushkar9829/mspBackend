import mongoose from "mongoose";

/**
 * The platform's own tax documents to the buyer of an order (split invoicing, phase 4): the
 * platform is the supplier of the platform fee (SAC 998599) and the platform courier / delivery
 * partner fee (SAC 996812). Own number series per prefix + financial year
 * (platform.orderInvoicePrefix, e.g. MSPF/2627/000001; credit notes MSPF/2627/C00001), kept in
 * PlatformInvoiceCounter under keys `ORD:<prefix>:<fy>` / `ORDCN:<prefix>:<fy>` (separate from
 * the subscription invoice series). Same line / totals shape as seller invoices, so the same PDF
 * renderer is used; `seller` holds the platform supplier identity.
 */
const lineSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["item", "fee"], default: "fee" },
    feeKey: { type: String, enum: ["platform", "partner"], default: "platform" },
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
  { name: String, legalName: String, company: String, gstin: String, state: String, address: String, email: String, phone: String },
  { _id: false }
);

const totalsSchema = {
  grossAmount: Number,
  discount: Number,
  taxableValue: Number,
  cgst: Number,
  sgst: Number,
  igst: Number,
  tax: Number,
  grandTotal: Number,
};

const common = {
  /** Seller whose order this fee belongs to (for reports; the platform is the supplier). */
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  orderNumber: String,
  buyerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  prefix: { type: String, required: true },
  financialYear: { type: String, required: true },
  sequence: { type: Number, required: true },
  issuedAt: { type: Date, default: Date.now },
  /** Platform (supplier). Named `seller` so the shared PDF renderer prints it. */
  seller: partySchema,
  buyer: partySchema,
  placeOfSupply: String,
  supplyType: { type: String, enum: ["intra", "inter"], default: "intra" },
  placeOfSupplyUnknown: { type: Boolean, default: false },
  lines: [lineSchema],
  totals: totalsSchema,
};

const platformInvoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true },
    status: { type: String, enum: ["issued", "cancelled"], default: "issued" },
    sellerInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null },
    sellerInvoiceNumber: { type: String, default: "" },
    paymentMethod: String,
    ...common,
  },
  { timestamps: true }
);
platformInvoiceSchema.index({ orderId: 1 }, { unique: true });
platformInvoiceSchema.index({ issuedAt: 1 });

const platformCreditNoteSchema = new mongoose.Schema(
  {
    creditNoteNumber: { type: String, required: true, unique: true },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "PlatformOrderInvoice", required: true },
    invoiceNumber: String,
    reason: { type: String, default: "" },
    refundKey: { type: String, required: true },
    scope: { type: String, enum: ["full", "partial"], default: "full" },
    returnId: { type: mongoose.Schema.Types.ObjectId, default: null },
    ...common,
  },
  { timestamps: true }
);
platformCreditNoteSchema.index({ orderId: 1, refundKey: 1 }, { unique: true });
platformCreditNoteSchema.index({ issuedAt: 1 });

export const PlatformOrderInvoice =
  mongoose.models.PlatformOrderInvoice || mongoose.model("PlatformOrderInvoice", platformInvoiceSchema);
export const PlatformCreditNote =
  mongoose.models.PlatformCreditNote || mongoose.model("PlatformCreditNote", platformCreditNoteSchema);
