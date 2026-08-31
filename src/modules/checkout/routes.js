import { Router } from "express";
import { z } from "zod";
import { authenticate, optionalAuth } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { couponLimiter } from "../../middleware/rateLimits.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import * as cartService from "../cart/service.js";
import * as checkoutService from "./service.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i);

function cartIdentity(req) {
  if (req.user) return { userId: req.user._id, guestKey: null };
  const guestKey = req.headers["x-guest-key"];
  if (!guestKey) {
    throw new AppError(400, "X-Guest-Key required for guest cart", "GUEST_KEY");
  }
  return { userId: null, guestKey: String(guestKey) };
}

export const cartRouter = Router();
cartRouter.use(optionalAuth);

cartRouter.get("/", asyncHandler(async (req, res) => {
  const { userId, guestKey } = cartIdentity(req);
  const cart = await cartService.getOrCreateCart(userId, guestKey);
  res.json(await cartService.quoteCart(cart, userId));
}));

cartRouter.get("/coupons", asyncHandler(async (req, res) => {
  const { userId, guestKey } = cartIdentity(req);
  res.json(await cartService.listCartCoupons(userId, guestKey));
}));

cartRouter.post(
  "/items",
  validate(z.object({ body: z.object({ variantId: objectId, qty: z.number().int().positive() }) })),
  asyncHandler(async (req, res) => {
    const { userId, guestKey } = cartIdentity(req);
    res.json(await cartService.addItem(userId, guestKey, req.body));
  })
);

cartRouter.patch(
  "/items/:id",
  validate(z.object({ body: z.object({ qty: z.number().int().positive() }) })),
  asyncHandler(async (req, res) => {
    const { userId, guestKey } = cartIdentity(req);
    res.json(await cartService.updateQty(userId, guestKey, req.params.id, req.body.qty));
  })
);

cartRouter.delete("/items/:id", asyncHandler(async (req, res) => {
  const { userId, guestKey } = cartIdentity(req);
  res.json(await cartService.removeItem(userId, guestKey, req.params.id));
}));

cartRouter.post(
  "/coupon",
  couponLimiter,
  validate(z.object({ body: z.object({ code: z.string().optional() }) })),
  asyncHandler(async (req, res) => {
    const { userId, guestKey } = cartIdentity(req);
    res.json(await cartService.applyCartCoupon(userId, guestKey, req.body.code));
  })
);

cartRouter.post(
  "/merge",
  authenticate,
  asyncHandler(async (req, res) => {
    const guestKey = req.headers["x-guest-key"] ? String(req.headers["x-guest-key"]) : "";
    res.json(await cartService.mergeGuestCart(req.user._id, guestKey));
  })
);

const PAYMENT = z.enum(["upi", "card", "netbanking", "cod", "purchase_order", "credit_terms"]);

export const checkoutRouter = Router();
checkoutRouter.use(authenticate, authorize("orders.create"));
checkoutRouter.post(
  "/preview",
  validate(z.object({ body: z.object({ addressId: objectId }) })),
  asyncHandler(async (req, res) => {
    res.json(await checkoutService.previewCheckout({ user: req.user, addressId: req.body.addressId }));
  })
);
checkoutRouter.post(
  "/",
  validate(
    z.object({
      body: z.object({
        addressId: objectId,
        paymentMethod: PAYMENT.optional(),
        poNumber: z.string().optional(),
        buyerNotes: z.string().max(1000).optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const idempotencyKey = req.headers["idempotency-key"];
    const result = await checkoutService.checkout({
      user: req.user,
      addressId: req.body.addressId,
      paymentMethod: req.body.paymentMethod,
      poNumber: req.body.poNumber,
      buyerNotes: req.body.buyerNotes,
      idempotencyKey,
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  })
);
