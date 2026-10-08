import { Router } from "express";
import { z } from "zod";
import { authenticate, optionalAuth, requireVerifiedEmail } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { couponLimiter } from "../../middleware/rateLimits.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import * as cartService from "../cart/service.js";
import * as checkoutService from "./service.js";
import { handleRazorpayWebhook } from "./razorpay.js";

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
  const tenantId = /^[a-f\d]{24}$/i.test(String(req.query.tenantId || "")) ? String(req.query.tenantId) : null;
  res.json(await cartService.listCartCoupons(userId, guestKey, { tenantId, homeTenantId: req.user?.homeTenantId || null }));
}));

cartRouter.post(
  "/items",
  validate(
    z.object({
      body: z.object({
        variantId: objectId,
        qty: z.number().int().positive(),
        fulfillmentMode: z.enum(["store_pickup", "delivery_partner"]).optional(),
        // One line per variant: `bulk` / `mode` are hints only (bulk is derived from the quantity).
        bulk: z.boolean().optional(),
        mode: z.enum(["regular", "single", "bulk"]).optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { userId, guestKey } = cartIdentity(req);
    const { mode, ...body } = req.body;
    res.json(await cartService.addItem(userId, guestKey, { ...body, bulk: body.bulk ?? mode === "bulk" }));
  })
);

cartRouter.patch(
  "/items/:id",
  validate(
    z.object({
      body: z
        .object({
          qty: z.number().int().positive().optional(),
          fulfillmentMode: z.enum(["store_pickup", "delivery_partner"]).optional(),
        })
        .refine((b) => b.qty != null || b.fulfillmentMode, { message: "qty or fulfillmentMode is required" }),
    })
  ),
  asyncHandler(async (req, res) => {
    const { userId, guestKey } = cartIdentity(req);
    res.json(await cartService.updateItem(userId, guestKey, req.params.id, req.body));
  })
);

cartRouter.delete("/items/:id", asyncHandler(async (req, res) => {
  const { userId, guestKey } = cartIdentity(req);
  res.json(await cartService.removeItem(userId, guestKey, req.params.id));
}));

cartRouter.post(
  "/coupon",
  couponLimiter,
  validate(z.object({ body: z.object({ code: z.string().max(40).optional() }) })),
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

checkoutRouter.post(
  "/razorpay/webhook",
  asyncHandler(async (req, res) => {
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    res.json(await handleRazorpayWebhook(raw, req.get("x-razorpay-signature") || ""));
  })
);

checkoutRouter.use(authenticate, requireVerifiedEmail, authorize("orders.create"));

checkoutRouter.post(
  "/pay",
  validate(z.object({ body: z.object({ orderId: objectId }) })),
  asyncHandler(async (req, res) => {
    res.json(await checkoutService.resumeRazorpayPayment({ user: req.user, orderId: req.body.orderId }));
  })
);
checkoutRouter.post(
  "/verify",
  validate(
    z.object({
      body: z.object({
        razorpay_order_id: z.string().min(1),
        razorpay_payment_id: z.string().min(1),
        razorpay_signature: z.string().min(1),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const orders = await checkoutService.verifyRazorpayPayment({
      user: req.user,
      razorpayOrderId: req.body.razorpay_order_id,
      razorpayPaymentId: req.body.razorpay_payment_id,
      razorpaySignature: req.body.razorpay_signature,
    });
    res.json({ orders });
  })
);
/** Allowed payment methods per store group of the cart (and overall), with reasons. */
checkoutRouter.get(
  "/payment-options",
  validate(z.object({ query: z.object({ addressId: objectId.optional() }).passthrough() })),
  asyncHandler(async (req, res) => {
    res.json(await checkoutService.paymentOptions({ user: req.user, addressId: req.query.addressId }));
  })
);
checkoutRouter.post(
  "/preview",
  validate(z.object({ body: z.object({ addressId: objectId, deliveryPartnerId: z.string().max(80).optional() }) })),
  asyncHandler(async (req, res) => {
    res.json(
      await checkoutService.previewCheckout({
        user: req.user,
        addressId: req.body.addressId,
        deliveryPartnerId: req.body.deliveryPartnerId,
      })
    );
  })
);
checkoutRouter.post(
  "/",
  validate(
    z.object({
      body: z.object({
        addressId: objectId,
        paymentMethod: PAYMENT,
        poNumber: z.string().max(80).optional(),
        buyerNotes: z.string().max(1000).optional(),
        deliveryPartnerId: z.string().max(80).optional(),
        expectedGrandTotal: z.number().nonnegative(),
      }).strict(),
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
      deliveryPartnerId: req.body.deliveryPartnerId,
      expectedGrandTotal: req.body.expectedGrandTotal,
      idempotencyKey,
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  })
);
