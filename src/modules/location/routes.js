import { Router } from "express";
import { z } from "zod";
import { authenticate, optionalAuth } from "../../middleware/authenticate.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";
import { User } from "../users/user.model.js";
import { lookupPincode, PINCODE_RX } from "./pincode.js";
import { pincodeLimiter } from "../../middleware/rateLimits.js";

const pincodeSchema = z.object({
  params: z.object({ pin: z.string().trim().regex(PINCODE_RX, "PIN code must be 6 digits and not start with 0") }),
});

const suggestSchema = z.object({
  query: z.object({
    q: z.string().max(100).optional(),
    postalCode: z.string().max(12).optional(),
    city: z.string().max(100).optional(),
  }),
});

const serviceabilitySchema = z.object({
  query: z.object({
    tenantId: z.string().regex(/^[a-f\d]{24}$/i),
    postalCode: z.string().min(3),
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
    /** true when the coordinates came from the stub geocoder (radius zones are then skipped). */
    approximate: z
      .preprocess((v) => (Array.isArray(v) ? v[0] : v), z.enum(["true", "false", "1", "0"]).optional())
      .transform((v) => v === "true" || v === "1"),
  }),
});

const body = (schema) => z.preprocess((v) => v ?? {}, schema);

const geocodeSchema = z.object({
  body: body(
    z
      .object({
        addressLine1: z.string().max(300).optional(),
        city: z.string().max(100).optional(),
        state: z.string().max(100).optional(),
        postalCode: z.string().max(12).optional(),
      })
      .strict()
      .refine((b) => b.addressLine1 || b.city || b.postalCode, { message: "addressLine1, city or postalCode required" })
  ),
});

const myLocationSchema = z.object({
  body: body(
    z
      .object({
        city: z.string().trim().max(100).optional(),
        state: z.string().trim().max(100).optional(),
        postalCode: z.string().trim().max(12).optional(),
        country: z.string().trim().length(2).optional(),
        latitude: z.number().min(-90).max(90).nullable().optional(),
        longitude: z.number().min(-180).max(180).nullable().optional(),
      })
      .strict()
  ),
});

const locationRouter = Router();

locationRouter.post(
  "/geocode",
  authenticate,
  validate(geocodeSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.geocodeAddress(req.body));
  })
);

locationRouter.get(
  "/suggest",
  optionalAuth,
  validate(suggestSchema),
  asyncHandler(async (req, res) => {
    const geo = await service.geocodeAddress({
      postalCode: req.query.postalCode,
      city: req.query.city || req.query.q,
    });
    res.json({ query: req.query, suggestions: [geo] });
  })
);

/** Public: PIN code → { pincode, city, district, state, stateCode, approximate, found, source }. */
locationRouter.get(
  "/pincode/:pin",
  pincodeLimiter,
  validate(pincodeSchema),
  asyncHandler(async (req, res) => {
    res.json(await lookupPincode(req.params.pin.trim()));
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
      approximate: req.validated.query.approximate,
    });
    res.json(result);
  })
);

locationRouter.put(
  "/me",
  authenticate,
  validate(myLocationSchema),
  asyncHandler(async (req, res) => {
    const loc = req.body;
    req.user.profile = req.user.profile || {};
    req.user.profile.location = {
      city: loc.city,
      state: loc.state,
      postalCode: loc.postalCode,
      country: loc.country || "IN",
      latitude: loc.latitude ?? null,
      longitude: loc.longitude ?? null,
    };
    await User.findByIdAndUpdate(req.user._id, { "profile.location": req.user.profile.location });
    res.json(req.user.profile.location);
  })
);

export default locationRouter;
