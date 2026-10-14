import mongoose from "mongoose";
import { PRIVATE_UPLOAD_FOLDERS } from "../../config/constants.js";

/**
 * A privately stored upload (e.g. seller KYC documents). The bytes live under
 * utils/storage.js privateUploadRoot (never under the public /uploads route); they are streamed by
 * GET /api/v1/files/private/:id to the uploader's tenant staff, the uploader, or a platform admin.
 */
const privateFileSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    key: { type: String, required: true, unique: true },
    filename: { type: String, default: "" },
    originalName: { type: String, default: "" },
    mimeType: { type: String, default: "" },
    size: { type: Number, default: 0 },
    folder: { type: String, enum: PRIVATE_UPLOAD_FOLDERS, default: "kyc" },
    /** Free-form label, e.g. "gst_certificate", "pan", "cancelled_cheque". */
    purpose: { type: String, default: "" },
  },
  { timestamps: true }
);

privateFileSchema.index({ tenantId: 1, folder: 1, createdAt: -1 });

export const PrivateFile = mongoose.model("PrivateFile", privateFileSchema);
