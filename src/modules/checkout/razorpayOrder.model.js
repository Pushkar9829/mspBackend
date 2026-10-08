import mongoose from "mongoose";

/**
 * One row per Razorpay order we create: which seller orders it was created for and for how
 * much. Seller orders move on to newer Razorpay orders (razorpayOrderHistory), so this is the
 * only durable record of what a late payment on an older Razorpay order was meant to cover.
 */
const razorpayOrderSchema = new mongoose.Schema(
  {
    _id: { type: String }, // Razorpay order id
    orderIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    amountPaise: { type: Number, required: true, min: 0 },
  },
  { timestamps: true, versionKey: false }
);

export const RazorpayOrder = mongoose.models.RazorpayOrder || mongoose.model("RazorpayOrder", razorpayOrderSchema);
