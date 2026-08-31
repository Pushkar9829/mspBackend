import { Router } from "express";
import { z } from "zod";
import { authenticate, optionalAuth } from "../../middleware/authenticate.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";
import { User } from "../users/user.model.js";

const suggestSchema = z.object({
  query: z.object({
    q: z.string().optional(),
    postalCode: z.string().optional(),
    city: z.string().optional(),
  }),
});

const serviceabilitySchema = z.object({
  query: z.object({
    tenantId: z.string().regex(/^[a-f\d]{24}$/i),
    postalCode: z.string().min(3),
    latitude: z.coerce.number().optional(),
    longitude: z.coerce.number().optional(),
  }),
});

const locationRouter = Router();

locationRouter.get(
  "/suggest",
  optionalAuth,
  validate(suggestSchema),
  asyncHandler(async (req, res) => {
    const geo = await service.geocodeStub({
      postalCode: req.query.postalCode,
      city: req.query.city || req.query.q,
    });
    res.json({ query: req.query, suggestions: [geo] });
  })
);

locationRouter.get(
  "/serviceability",
  optionalAuth,
  validate(serviceabilitySchema),
  asyncHandler(async (req, res) => {
    const result = await service.checkServiceability({
      tenantId: req.query.tenantId,
      postalCode: req.query.postalCode,
      latitude: req.query.latitude,
      longitude: req.query.longitude,
    });
    res.json(result);
  })
);

locationRouter.put(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const loc = req.body || {};
    req.user.profile = req.user.profile || {};
    req.user.profile.location = {
      city: loc.city,
      state: loc.state,
      postalCode: loc.postalCode,
      country: loc.country || "IN",
      latitude: loc.latitude,
      longitude: loc.longitude,
    };
    await User.findByIdAndUpdate(req.user._id, { "profile.location": req.user.profile.location });
    res.json(req.user.profile.location);
  })
);

export default locationRouter;
