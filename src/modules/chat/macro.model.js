import mongoose from "mongoose";

/** Canned replies ("macros") per tenant. Replaces the ever-growing `chat.macros` Settings array. */
const chatMacroSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, required: true, maxlength: 4000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

chatMacroSchema.index({ tenantId: 1, createdAt: 1 });

export const MAX_MACROS_PER_TENANT = 200;
export const ChatMacro = mongoose.model("ChatMacro", chatMacroSchema);
