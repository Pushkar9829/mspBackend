import { Router } from "express";
import crypto from "crypto";
import fs from "fs/promises";
import multer from "multer";
import mongoose from "mongoose";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorizeAny, hasPermission } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { storage } from "../../utils/storage.js";
import { env } from "../../config/env.js";
import { MAX_UPLOAD_BYTES, PRIVATE_UPLOAD_FOLDERS } from "../../config/constants.js";
import { PrivateFile } from "./privateFile.model.js";

/**
 * Private files (mounted at /api/v1/files by middleware/platform.js):
 *   POST   /private            multipart `file` (+ folder=kyc, purpose) → 201 file row
 *   GET    /private            list the caller's tenant files (platform admin: X-Tenant-Id / all)
 *   GET    /private/:id        stream the file (Bearer + ownership, or ?exp=&sig= signed link)
 *   GET    /private/:id/link   { url, expiresAt } short-lived signed link (5 min) for <a>/<img>
 *   DELETE /private/:id        remove (owner tenant staff or platform admin)
 * Ownership: platform admin, staff of the file's tenant, or the uploader. Others get 404.
 * Delivery riders (phase 5) may only upload to folder=delivery and only see their own uploads.
 */

const SIGNED_TTL_SECONDS = 5 * 60;
const INLINE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"]);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

/** Domain-separated key so a signed file link can never be confused with any other token. */
function signingKey() {
  return crypto.createHash("sha256").update(`msp:private-file:${env.jwtAccessSecret}`).digest();
}

export function signPrivateFile(id, exp) {
  return crypto.createHmac("sha256", signingKey()).update(`${id}.${exp}`).digest("base64url");
}

export function verifyPrivateFileSignature(id, exp, sig) {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum * 1000 < Date.now() || !sig) return false;
  const expected = Buffer.from(signPrivateFile(String(id), String(exp)));
  const given = Buffer.from(String(sig));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function present(row) {
  return {
    id: row._id,
    tenantId: row.tenantId || null,
    uploadedBy: row.uploadedBy || null,
    folder: row.folder,
    purpose: row.purpose || "",
    filename: row.filename,
    originalName: row.originalName || "",
    mimeType: row.mimeType,
    size: row.size,
    private: true,
    url: `/api/v1/files/private/${row._id}`,
    createdAt: row.createdAt,
  };
}

function isRiderReq(req) {
  return req?.role?.isSystem === true && req.role.slug === "rider";
}

/** True when the request may access this file. */
export function canAccessPrivateFile(req, row) {
  if (!req?.user || !row) return false;
  if (req.isPlatformAdmin) return true;
  // Riders belong to a store but must never read its other private files (KYC etc.).
  if (isRiderReq(req)) return Boolean(row.uploadedBy) && String(row.uploadedBy) === String(req.user._id);
  const own = req.tenantId || req.user?.tenantId?._id || req.user?.tenantId || null;
  if (row.tenantId && own && String(row.tenantId) === String(own)) return true;
  return Boolean(row.uploadedBy) && String(row.uploadedBy) === String(req.user._id);
}

async function loadOwned(req, id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError(404, "File not found", "NOT_FOUND");
  const row = await PrivateFile.findById(id).lean();
  // Buyers (phase 6) only ever reach their own dispute evidence; anything else stays 403 for them.
  if (req.buyerDisputeFiles && (!row || row.folder !== "disputes")) throw new AppError(403, "Insufficient permissions", "FORBIDDEN");
  if (!row || !canAccessPrivateFile(req, row)) throw new AppError(404, "File not found", "NOT_FOUND");
  if (req.allowedFolders && !req.allowedFolders.includes(row.folder)) throw new AppError(404, "File not found", "NOT_FOUND");
  return row;
}

async function sendPrivate(req, res, row) {
  const full = storage.privatePath(row.key);
  if (!full) throw new AppError(404, "File not found", "NOT_FOUND");
  try {
    await fs.access(full);
  } catch {
    throw new AppError(404, "File not found", "NOT_FOUND");
  }
  const inline = String(req.query.disposition || "") === "inline" && INLINE_MIME.has(row.mimeType);
  const name = String(row.originalName || row.filename || "file").replace(/["\r\n\\]/g, "_");
  res.setHeader("Content-Type", row.mimeType || "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${name}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.sendFile(full, { dotfiles: "deny" });
}

const idParams = z.object({ params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid id") }) });
const uploadSchema = z.object({
  body: z
    .object({
      folder: z.enum(PRIVATE_UPLOAD_FOLDERS).default("kyc"),
      purpose: z.string().trim().max(60).optional().default(""),
    })
    .passthrough(),
});
const listSchema = z.object({
  query: z.object({ folder: z.enum(PRIVATE_UPLOAD_FOLDERS).optional() }).passthrough(),
});

const staffManage = authorizeAny("settings.edit", "media.upload", "tenants.edit", "riders.manage");
const staffView = authorizeAny("settings.view", "settings.edit", "media.upload", "tenants.view", "tenants.edit", "riders.manage");
/** Riders (rider.app) pass; ownership / folder rules are applied per route. */
const riderOr = (guard) => (req, res, next) => (isRiderReq(req) && (req.permissions || []).includes("rider.app") ? next() : guard(req, res, next));
const canManage = riderOr(staffManage);
const canView = riderOr(staffView);
/**
 * Phase 6: buyers and store staff handling returns (returns.manage / orders.refund) may upload
 * dispute evidence / QC photos (folder `disputes` only). Buyers' files have no tenant.
 */
const isBuyerReq = (req) => Boolean(req.isBuyer) && !req.isPlatformAdmin;
const canUpload = (req, res, next) =>
  canManage(req, res, (err) => {
    if (!err) return next();
    if (isBuyerReq(req) || (!req.isBuyer && (hasPermission(req, "returns.manage") || hasPermission(req, "orders.refund")))) {
      req.disputeUploadOnly = true;
      return next();
    }
    return next(err);
  });
/**
 * Order staff (orders.view / orders.update) without file permissions may still open delivery
 * proof (folder `delivery`: rider photos, return checks) — never KYC or other private files.
 */
const canViewFile = (req, res, next) =>
  canView(req, res, (err) => {
    if (!err) return next();
    // Store staff only (buyers also hold orders.view).
    const staff = !req.isBuyer && Boolean(req.user?.tenantId);
    if (staff && (hasPermission(req, "orders.view") || hasPermission(req, "orders.update"))) {
      req.allowedFolders = ["delivery", "disputes"];
      return next();
    }
    // Phase 6: buyers may open their own dispute evidence (ownership checked by loadOwned).
    if (isBuyerReq(req)) {
      req.allowedFolders = ["disputes"];
      req.buyerDisputeFiles = true;
      return next();
    }
    return next(err);
  });

const router = Router();

/** Signed-link downloads skip auth (the signature is the credential). */
router.get(
  "/private/:id",
  asyncHandler(async (req, res, next) => {
    if (!req.query.sig) return next();
    const id = String(req.params.id);
    if (!mongoose.isValidObjectId(id) || !verifyPrivateFileSignature(id, req.query.exp, req.query.sig)) {
      throw new AppError(403, "Link expired or invalid", "LINK_INVALID");
    }
    const row = await PrivateFile.findById(id).lean();
    if (!row) throw new AppError(404, "File not found", "NOT_FOUND");
    await sendPrivate(req, res, row);
  })
);

router.use("/private", authenticate, resolveTenant);

router.post(
  "/private",
  audit("create", "private_file"),
  canUpload,
  upload.single("file"),
  validate(uploadSchema),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, "File is required", "VALIDATION_ERROR");
    if (isRiderReq(req) && req.body.folder !== "delivery") {
      throw new AppError(403, "Riders can only upload delivery photos (folder=delivery)", "FORBIDDEN");
    }
    if (req.disputeUploadOnly && req.body.folder !== "disputes") {
      throw new AppError(403, "You can only upload dispute evidence (folder=disputes)", "FORBIDDEN");
    }
    const tenantId = isBuyerReq(req) ? null : req.tenantId || null;
    if (!tenantId && !req.isPlatformAdmin && req.body.folder !== "disputes") throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
    const saved = await storage.save({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      folder: req.body.folder,
      isPrivate: true,
    });
    try {
      const row = await PrivateFile.create({
        tenantId,
        uploadedBy: req.user._id,
        key: saved.key,
        filename: saved.filename,
        originalName: saved.originalName,
        mimeType: saved.mimeType,
        size: saved.size,
        folder: saved.folder,
        purpose: req.body.purpose || "",
      });
      res.status(201).json(present(row));
    } catch (err) {
      await storage.remove(saved.key, { isPrivate: true }).catch(() => {});
      throw err;
    }
  })
);

router.get(
  "/private",
  canView,
  validate(listSchema),
  asyncHandler(async (req, res) => {
    const filter = {};
    if (req.isPlatformAdmin) {
      if (req.tenantId) filter.tenantId = req.tenantId;
    } else if (isRiderReq(req)) {
      filter.uploadedBy = req.user._id;
    } else if (req.tenantId) {
      filter.tenantId = req.tenantId;
    } else {
      filter.uploadedBy = req.user._id;
    }
    if (req.query.folder) filter.folder = req.query.folder;
    const rows = await PrivateFile.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ data: rows.map(present) });
  })
);

router.get(
  "/private/:id/link",
  canViewFile,
  validate(idParams),
  asyncHandler(async (req, res) => {
    const row = await loadOwned(req, req.params.id);
    const exp = Math.floor(Date.now() / 1000) + SIGNED_TTL_SECONDS;
    const sig = signPrivateFile(String(row._id), String(exp));
    res.json({
      url: `/api/v1/files/private/${row._id}?exp=${exp}&sig=${sig}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  })
);

router.get(
  "/private/:id",
  canViewFile,
  validate(idParams),
  asyncHandler(async (req, res) => {
    await sendPrivate(req, res, await loadOwned(req, req.params.id));
  })
);

router.delete(
  "/private/:id",
  audit("delete", "private_file"),
  canManage,
  validate(idParams),
  asyncHandler(async (req, res) => {
    const row = await loadOwned(req, req.params.id);
    await PrivateFile.deleteOne({ _id: row._id });
    await storage.remove(row.key, { isPrivate: true });
    res.json({ ok: true, id: row._id });
  })
);

export default router;
