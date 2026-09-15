import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "path";
import mongoose from "mongoose";
import { env, isOriginAllowed } from "./config/env.js";
import { requestId } from "./middleware/requestId.js";
import { notFound, errorHandler } from "./middleware/error.js";
import v1 from "./routes/v1.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);

  app.use(requestId);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (isOriginAllowed(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Tenant-Id",
        "X-Guest-Key",
        "Idempotency-Key",
      ],
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use("/uploads", express.static(path.resolve(process.cwd(), env.uploadDir)));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "mspNode",
      requestId: _req.requestId,
      time: new Date().toISOString(),
      mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    });
  });

  app.use("/api/v1", v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
