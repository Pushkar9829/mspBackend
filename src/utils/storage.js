import fs from "fs/promises";
import path from "path";
import { nanoid } from "nanoid";
import { env } from "../config/env.js";
import { AppError } from "./AppError.js";
import { ALLOWED_MIME, MAX_UPLOAD_BYTES, UPLOAD_FOLDERS, PRIVATE_UPLOAD_FOLDERS } from "../config/constants.js";

/**
 * Local-disk storage for uploads.
 *
 * Security rules (audit S4):
 * - `folder` is whitelisted (UPLOAD_FOLDERS); anything else becomes "general". No path segments.
 * - The client file name and client MIME type are ignored. The type is sniffed from magic bytes
 *   (png / jpeg / webp / gif / pdf only) and the extension is derived from the sniffed type.
 * - Files are served by app.js with `X-Content-Type-Options: nosniff`, a sandbox CSP, and
 *   `Content-Disposition: attachment` for anything that isn't an image.
 *
 * Deployment: on Vercel the default dir is /tmp/uploads, which is per-instance and ephemeral —
 * persistent uploads there need object storage (S3/R2/Cloudinary). On Render, attach a disk or
 * use object storage as well; the free plan's filesystem is wiped on each deploy.
 */

export const uploadRoot = path.resolve(process.cwd(), env.uploadDir);

/**
 * Private uploads (KYC documents etc.): a SEPARATE directory next to the public one (default
 * "<uploadDir>-private", or PRIVATE_UPLOAD_DIR). It is never mounted by the /uploads static route;
 * files are streamed by GET /api/v1/files/private/:id after an ownership check.
 */
export const privateUploadRoot = path.resolve(
  process.cwd(),
  process.env.PRIVATE_UPLOAD_DIR || path.join(path.dirname(env.uploadDir), `${path.basename(env.uploadDir)}-private`)
);
if (privateUploadRoot === uploadRoot || privateUploadRoot.startsWith(uploadRoot + path.sep)) {
  throw new Error("PRIVATE_UPLOAD_DIR must not be inside the public upload dir");
}

export function isPrivateFolder(folder) {
  return PRIVATE_UPLOAD_FOLDERS.includes(String(folder || "").trim().toLowerCase());
}

const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};

/** Detect the real file type from its first bytes. Returns a MIME type or null. */
export function sniffMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const b = buffer;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png";
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a") return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

export function normalizeFolder(folder) {
  const f = String(folder || "").trim().toLowerCase();
  return UPLOAD_FOLDERS.includes(f) ? f : "general";
}

export function isImageMime(mime) {
  return typeof mime === "string" && mime.startsWith("image/");
}

export async function ensureUploadDir() {
  await fs.mkdir(uploadRoot, { recursive: true });
  await fs.mkdir(privateUploadRoot, { recursive: true });
}

/**
 * Save an upload. `originalName` and `mimeType` from the client are accepted for API compatibility
 * but never trusted. Returns { key, url, filename, mimeType, size, folder, originalName, private }.
 * Private folders (PRIVATE_UPLOAD_FOLDERS, e.g. "kyc") or `isPrivate: true` are written under
 * privateUploadRoot and get `url: null` (the caller records the file and exposes
 * /api/v1/files/private/:id).
 */
export async function saveLocalFile({ buffer, originalName = "", folder = "general", maxBytes = MAX_UPLOAD_BYTES, isPrivate = false } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError(400, "File is empty", "FILE_EMPTY");
  }
  if (buffer.length > maxBytes) {
    throw new AppError(413, "File too large", "FILE_TOO_LARGE");
  }
  const mimeType = sniffMime(buffer);
  if (!mimeType || !ALLOWED_MIME.includes(mimeType)) {
    throw new AppError(400, "File type not allowed (png, jpeg, webp, gif, pdf only)", "FILE_TYPE");
  }

  const safeFolder = normalizeFolder(folder);
  const priv = Boolean(isPrivate) || isPrivateFolder(safeFolder);
  const root = priv ? privateUploadRoot : uploadRoot;
  const dir = path.join(root, safeFolder);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${nanoid(16)}${EXT_BY_MIME[mimeType]}`;
  const full = path.join(dir, filename);
  if (!full.startsWith(root + path.sep)) {
    throw new AppError(400, "Invalid upload path", "UPLOAD_ERROR");
  }
  await fs.writeFile(full, buffer, { flag: "wx" });
  const key = `${safeFolder}/${filename}`;
  return {
    key,
    url: priv ? null : `/uploads/${key}`,
    private: priv,
    filename,
    mimeType,
    size: buffer.length,
    folder: safeFolder,
    originalName: String(originalName || "").replace(/[^\w.\- ]+/g, "_").slice(0, 120),
  };
}

/** Absolute path of a private file key, or null when the key escapes the private root. */
export function privateFilePath(key) {
  if (!key || typeof key !== "string") return null;
  const full = path.resolve(privateUploadRoot, key);
  return full.startsWith(privateUploadRoot + path.sep) ? full : null;
}

/** Delete a stored file by key (`isPrivate` = private root). Keys outside the root are ignored. */
export async function deleteLocalFile(key, { isPrivate = false } = {}) {
  if (!key || typeof key !== "string") return;
  const root = isPrivate ? privateUploadRoot : uploadRoot;
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) return;
  try {
    await fs.unlink(full);
  } catch {
    /* ignore missing */
  }
}

export const storage = {
  save: saveLocalFile,
  remove: deleteLocalFile,
  ensure: ensureUploadDir,
  sniff: sniffMime,
  root: uploadRoot,
  privateRoot: privateUploadRoot,
  privatePath: privateFilePath,
};
