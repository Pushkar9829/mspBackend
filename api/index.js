/**
 * Vercel serverless entry.
 *
 * Limitations on Vercel (see docs/API.md "Deployment"):
 * - WebSockets / Socket.IO do NOT work here (no long-lived server). Realtime chat/notifications
 *   only work on a long-running host (Render). Clients fall back to REST polling.
 * - No in-process cron: scheduled jobs run through Vercel Cron → /api/internal/cron/:name
 *   (vercel.json "crons"; requires CRON_SECRET).
 * - Filesystem is read-only except /tmp (per-instance, ephemeral): uploads need object storage.
 * - In-memory rate limits are per instance.
 */
import { app, prepareRuntime } from "../src/bootstrap.js";

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  try {
    await prepareRuntime();
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "runtime init failed", err: err?.message }));
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: "Service unavailable", code: "NOT_READY" }));
    return;
  }
  return app(req, res);
}
