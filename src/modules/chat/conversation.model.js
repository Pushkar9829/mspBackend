import mongoose from "mongoose";
import { CONVERSATION_TYPES, CONVERSATION_STATUSES } from "../../config/constants.js";

const conversationSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    assigneeId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    type: { type: String, enum: CONVERSATION_TYPES, default: "general_support" },
    status: { type: String, enum: CONVERSATION_STATUSES, default: "unassigned", index: true },
    subject: { type: String, default: "" },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
    tags: [{ type: String }],
    escalated: { type: Boolean, default: false },
    unreadBuyer: { type: Number, default: 0 },
    unreadAgent: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: Date.now },
    cannedReplies: [{ title: String, body: String }],
  },
  { timestamps: true }
);

conversationSchema.index({ tenantId: 1, status: 1, lastMessageAt: -1 });

export const Conversation = mongoose.model("Conversation", conversationSchema);
