import express from "express";
import crypto from "crypto";
import path from "path";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { notFound } from "./error.js";
import { uploadRoot } from "../utils/storage.js";
import { logger } from "../utils/logger.js";

const SERVED_UPLOAD_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Bearer CRON_SECRET (Vercel Cron sends this header automatically when CRON_SECRET is set). */
export function cronAuth(req, res, next) {
  if (!env.cronSecret) {
    return res.status(503).json({ message: "CRON_SECRET not configured", code: "CRON_DISABLED", requestId: req.requestId });
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !safeEqual(token, env.cronSecret)) {
    return res.status(401).json({ message: "Unauthorized", code: "UNAUTHORIZED", requestId: req.requestId });
  }
  next();
}

export async function runCron(req, res, next) {
  try {
    const jobs = await import("../jobs/index.js");
    if (typeof jobs.runJob !== "function") {
      return res.status(501).json({ message: "Job runner not available", code: "NOT_IMPLEMENTED", requestId: req.requestId });
    }
    const name = String(req.params.name || "");
    if (jobs.JOBS && !Object.prototype.hasOwnProperty.call(jobs.JOBS, name)) {
      return res.status(404).json({ message: "Unknown job", code: "NOT_FOUND", requestId: req.requestId });
    }
    const started = Date.now();
    const result = await jobs.runJob(name);
    logger.info("cron job finished", { job: name, ms: Date.now() - started, requestId: req.requestId });
    res.json({ ok: true, job: name, ms: Date.now() - started, result: result ?? null });
  } catch (err) {
    next(err);
  }
}

/** Mounts /uploads (hardened static), /api/health, /api/ready and /api/internal/cron/:name. */
export function mountPlatformRoutes(app) {
  // User uploads: never executable in the API origin.
  app.use(
    "/uploads",
    (req, res, next) => {
      const ext = path.extname(req.path).toLowerCase();
      if (!SERVED_UPLOAD_EXT.has(ext)) return notFound(req, res);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
      res.setHeader("Content-Disposition", IMAGE_EXT.has(ext) ? "inline" : "attachment");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      next();
    },
    express.static(uploadRoot, { dotfiles: "deny", index: false, redirect: false, fallthrough: true, maxAge: "7d" })
  );

  // Liveness: process is up.
  app.get("/api/health", (req, res) => {
    res.json({ ok: true, service: "mspNode", requestId: req.requestId, time: new Date().toISOString() });
  });

  // Readiness: 503 unless MongoDB is connected.
  app.get("/api/ready", (req, res) => {
    const ready = mongoose.connection.readyState === 1;
    res.status(ready ? 200 : 503).json({
      ok: ready,
      mongo: ready ? "connected" : "disconnected",
      requestId: req.requestId,
    });
  });

  app.all("/api/internal/cron/:name", cronAuth, runCron);

}
