import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./address.service.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i);

const bodySchema = z.object({
  body: z.object({
    label: z.string().optional(),
    contactName: z.string().min(1),
    phone: z.string().min(5),
    addressLine1: z.string().min(1),
    addressLine2: z.string().optional(),
    city: z.string().min(1),
    state: z.string().min(1),
    postalCode: z.string().min(3),
    country: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    placeId: z.string().optional(),
    isDefault: z.boolean().optional(),
  }),
});

const router = Router();
router.use(authenticate);

router.get("/", asyncHandler(async (req, res) => {
  res.json(await service.listAddresses(req.user._id));
}));
router.post("/", validate(bodySchema), asyncHandler(async (req, res) => {
  res.status(201).json(await service.createAddress(req.user._id, req.body));
}));
router.patch("/:id", asyncHandler(async (req, res) => {
  res.json(await service.updateAddress(req.user._id, req.params.id, req.body));
}));
router.delete("/:id", asyncHandler(async (req, res) => {
  res.json(await service.deleteAddress(req.user._id, req.params.id));
}));

export default router;
