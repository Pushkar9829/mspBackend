import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { isOriginAllowed } from "./config/env.js";
import { requestId, requestLogger } from "./middleware/requestId.js";
import { notFound, errorHandler } from "./middleware/error.js";
import { mountPlatformRoutes } from "./middleware/platform.js";
import v1 from "./routes/v1.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(requestId);
  app.use(requestLogger);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );
  app.use(
    cors({
      origin(origin, callback) {
        callback(null, isOriginAllowed(origin));
      },
      credentials: true,
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Tenant-Id",
        "X-Guest-Key",
        "Idempotency-Key",
        "X-Client",
        "X-Request-Id",
      ],
      exposedHeaders: ["X-Request-Id", "Retry-After", "X-Export-Truncated", "X-Export-Total", "X-Export-Limit", "Content-Disposition", "X-Has-More", "X-Next-Before"],
    })
  );
  app.use(
    express.json({
      limit: "2mb",
      verify(req, _res, buf) {
        if (req.originalUrl?.includes("/checkout/razorpay/webhook")) req.rawBody = buf;
      },
    })
  );
  app.use(cookieParser());

  mountPlatformRoutes(app);

  app.use("/api/v1", v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
