import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./address.service.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i);

const addressFields = z
  .object({
    label: z.string().trim().max(60).optional(),
    contactName: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(5).max(20).regex(/^[+\d\s()-]+$/, "Invalid phone"),
    addressLine1: z.string().trim().min(1).max(300),
    addressLine2: z.string().trim().max(300).optional(),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().min(3).max(12),
    country: z.string().trim().length(2).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    placeId: z.string().max(300).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

const body = (schema) => z.preprocess((v) => v ?? {}, schema);

const bodySchema = z.object({ body: body(addressFields) });

// PATCH: any subset of the address fields; userId/_id/tenantId etc. are rejected (strict).
const patchSchema = z.object({
  params: z.object({ id: objectId }),
  body: body(
    addressFields
      .partial()
      .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" })
  ),
});

const idSchema = z.object({ params: z.object({ id: objectId }) });

const router = Router();
router.use(authenticate);

router.get("/", asyncHandler(async (req, res) => {
  res.json(await service.listAddresses(req.user._id));
}));
router.post("/", validate(bodySchema), asyncHandler(async (req, res) => {
  res.status(201).json(await service.createAddress(req.user._id, req.body));
}));
router.patch("/:id", validate(patchSchema), asyncHandler(async (req, res) => {
  res.json(await service.updateAddress(req.user._id, req.params.id, req.body));
}));
router.delete("/:id", validate(idSchema), asyncHandler(async (req, res) => {
  res.json(await service.deleteAddress(req.user._id, req.params.id));
}));

export default router;
