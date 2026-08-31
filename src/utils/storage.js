import fs from "fs/promises";
import path from "path";
import { nanoid } from "nanoid";
import { env } from "../config/env.js";
import { AppError } from "./AppError.js";
import { ALLOWED_MIME, MAX_UPLOAD_BYTES } from "../config/constants.js";

const root = path.resolve(process.cwd(), env.uploadDir);

export async function ensureUploadDir() {
  await fs.mkdir(root, { recursive: true });
}

export async function saveLocalFile({ buffer, originalName, mimeType, folder = "general" }) {
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new AppError(400, "File too large", "FILE_TOO_LARGE");
  }
  if (!ALLOWED_MIME.includes(mimeType)) {
    throw new AppError(400, "File type not allowed", "FILE_TYPE");
  }

  const ext = path.extname(originalName || "").toLowerCase() || mimeToExt(mimeType);
  const dir = path.join(root, folder);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${nanoid(16)}${ext}`;
  const full = path.join(dir, filename);
  await fs.writeFile(full, buffer);
  const relative = path.join(folder, filename).replaceAll("\\", "/");
  return {
    key: relative,
    url: `/uploads/${relative}`,
    filename,
    mimeType,
    size: buffer.length,
  };
}

export async function deleteLocalFile(key) {
  if (!key) return;
  const full = path.join(root, key);
  try {
    await fs.unlink(full);
  } catch {
    /* ignore missing */
  }
}

function mimeToExt(mime) {
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "application/pdf": ".pdf",
    "video/mp4": ".mp4",
  };
  return map[mime] || "";
}

export const storage = {
  save: saveLocalFile,
  remove: deleteLocalFile,
  ensure: ensureUploadDir,
};
