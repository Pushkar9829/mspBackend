import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize, authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant, requireStaff } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";
import { getCommerceSettings } from "../settings/commerce.js";
import { ORDER_STATUS_LIST, RETURN_REASONS, STATUS_LABELS } from "./statuses.js";
import { orderSla } from "./sla.js";
import { orderDeliveryView } from "../fleet/service.js";
import { attachDisputeInfo } from "../disputes/service.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
/** Order id or order number. */
const orderRef = z.object({ id: z.string().min(1).max(64) });
const note = z.string().max(1000).optional();
const damagedItems = z.array(z.object({ itemId: objectId, damagedQty: z.number().int().min(0) }).strict()).max(200).optional();
/** Return receive lines (phase 6: + quality-check rejected units with a reason). */
const receiveItems = z
  .array(
    z
      .object({
        itemId: objectId,
        damagedQty: z.number().int().min(0).optional(),
        rejectedQty: z.number().int().min(0).optional(),
        rejectReason: z.string().max(300).optional(),
      })
      .strict()
  )
  .max(200)
  .optional();
/** Where an offline (COD) refund is paid. Validated in detail by the service. */
const refundDestination = z
  .object({
    type: z.enum(["upi", "bank", "store_credit"]),
    upiId: z.string().max(256).optional(),
    accountName: z.string().max(100).optional(),
    accountNumber: z.string().max(34).optional(),
    ifsc: z.string().max(11).optional(),
  })
  .strict();

const router = Router();
router.use(authenticate);
// Buyers (system buyer role) see their own orders; everyone else is tenant-scoped staff.
router.use((req, res, next) => {
  if (req.isBuyer && !req.isPlatformAdmin) return next();
  return resolveTenant(req, res, next);
});

router.get("/", authorize("orders.view"), asyncHandler(async (req, res) => {
  res.json(await service.listOrders(req));
}));

/** Return reasons (code, label, sellerFault) and order status labels for clients. */
router.get("/meta", authorize("orders.view"), (req, res) => {
  res.json({ returnReasons: RETURN_REASONS, statusLabels: STATUS_LABELS });
});

/** Refund intents (default status=failed) across the store's orders. Staff only. */
router.get(
  "/refunds",
  authorizeAny("orders.refund", "orders.update"),
  requireStaff,
  asyncHandler(async (req, res) => {
    res.json(await service.listRefunds(req));
  })
);
/** Buyer: where to pay a pending COD refund (UPI / bank / store credit). */
router.post(
  "/:id/refunds/:key/destination",
  authorize("orders.view"),
  validate(z.object({ params: z.object({ id: z.string().min(1).max(64), key: z.string().min(1).max(200) }), body: refundDestination })),
  audit("refund_destination", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.setRefundDestination(req, req.params.id, req.params.key, req.body));
  })
);
/** Platform admin: an offline (COD) refund was paid out; `reference` = UTR / transaction id. */
router.post(
  "/:id/refunds/:key/mark-paid",
  authorize("orders.refund"),
  validate(
    z.object({
      params: z.object({ id: z.string().min(1).max(64), key: z.string().min(1).max(200) }),
      body: z.object({ reference: z.string().trim().min(1).max(100), note }).strict(),
    })
  ),
  audit("refund_mark_paid", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.markRefundPaid(req, req.params.id, req.params.key, req.body));
  })
);
router.post(
  "/:id/refunds/:key/retry",
  authorize("orders.refund"),
  requireStaff,
  validate(z.object({ params: z.object({ id: z.string().min(1).max(64), key: z.string().min(1).max(200) }) })),
  audit("refund_retry", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.retryRefund(req, req.params.id, req.params.key));
  })
);

router.get("/:id/invoice.pdf", authorize("orders.view"), validate(z.object({ params: orderRef })), asyncHandler(async (req, res) => {
  const { filename, buffer } = await service.getInvoicePdf(req, req.params.id);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(buffer);
}));
router.get("/:id/invoice", authorize("orders.view"), validate(z.object({ params: orderRef })), asyncHandler(async (req, res) => {
  res.json(await service.getInvoice(req, req.params.id));
}));
// Phase 4 split invoicing: seller + platform invoices of the order (each with its credit notes).
router.get("/:id/invoices", authorize("orders.view"), validate(z.object({ params: orderRef })), asyncHandler(async (req, res) => {
  res.json(await service.getInvoices(req, req.params.id));
}));
router.get("/:id/platform-invoice.pdf", authorize("orders.view"), validate(z.object({ params: orderRef })), asyncHandler(async (req, res) => {
  const { filename, buffer } = await service.getPlatformInvoicePdf(req, req.params.id);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(buffer);
}));
router.get("/:id/platform-invoice", authorize("orders.view"), validate(z.object({ params: orderRef })), asyncHandler(async (req, res) => {
  res.json(await service.getPlatformInvoice(req, req.params.id));
}));
router.get(
  "/:id/platform-credit-notes/:noteId.pdf",
  authorize("orders.view"),
  validate(z.object({ params: orderRef.extend({ noteId: z.string().min(1).max(64) }) })),
  asyncHandler(async (req, res) => {
    const { filename, buffer } = await service.getPlatformCreditNotePdf(req, req.params.id, req.params.noteId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(buffer);
  })
);
router.get(
  "/:id/credit-notes/:noteId.pdf",
  authorize("orders.view"),
  validate(z.object({ params: orderRef.extend({ noteId: z.string().min(1).max(64) }) })),
  asyncHandler(async (req, res) => {
    const { filename, buffer } = await service.getCreditNotePdf(req, req.params.id, req.params.noteId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(buffer);
  })
);
router.get("/:id/credit-notes", authorize("orders.view"), validate(z.object({ params: orderRef })), asyncHandler(async (req, res) => {
  res.json(await service.getCreditNotes(req, req.params.id));
}));
router.get("/:id/tracking", authorize("orders.view"), validate(z.object({ params: orderRef })), asyncHandler(async (req, res) => {
  res.json(await service.getTracking(req, req.params.id));
}));
router.get("/:id", authorize("orders.view"), validate(z.object({ params: orderRef })), asyncHandler(async (req, res) => {
  const [order, commerce, sla] = await Promise.all([service.getOrder(req, req.params.id), getCommerceSettings(), orderSla()]);
  // Phase 6: returns[].dispute = { kind, eligible, deadline, disputeId, status, statusLabel, reason } | null.
  const presented = await attachDisputeInfo(service.presentOrder(req, order));
  res.json({
    ...presented,
    returnUntil: service.returnDeadline(order, commerce),
    returnWindowDays: commerce.returnWindowDays,
    totals: service.orderTotals(order),
    allowedActions: service.allowedActions(req, order, commerce),
    sla: sla.forOrder(order),
    // Phase 5: own-fleet delivery (buyer: rider + OTP while out for delivery; staff: task card).
    delivery: await orderDeliveryView(req, order, { buyer: service.ownOrdersOnly(req) }),
  });
}));

router.post(
  "/:id/cancel",
  authorizeAny("orders.cancel", "orders.update"),
  validate(z.object({ params: orderRef, body: z.object({ note }).strict() })),
  audit("cancel", "order"),
  asyncHandler(async (req, res) => {
    res.json(service.presentOrder(req, await service.cancel(req, req.params.id, req.body.note)));
  })
);
router.post(
  "/:id/refund",
  authorize("orders.refund"),
  validate(z.object({ params: orderRef, body: z.object({ note }).strict() })),
  audit("refund", "order"),
  asyncHandler(async (req, res) => {
    res.json(service.presentOrder(req, await service.refund(req, req.params.id, req.body.note)));
  })
);
router.post(
  "/:id/return",
  authorize("orders.view"),
  validate(
    z.object({
      params: orderRef,
      body: z
        .object({
          reason: z.string().min(1).max(120),
          note,
          items: z.array(z.object({ itemId: objectId, qty: z.number().int().min(1) }).strict()).max(200).optional(),
          refundDestination: refundDestination.optional(),
        })
        .strict(),
    })
  ),
  audit("return_request", "order"),
  asyncHandler(async (req, res) => {
    res.json(service.presentOrder(req, await service.requestReturn(req, req.params.id, req.body)));
  })
);
router.post(
  "/:id/return/reject",
  authorizeAny("returns.manage", "orders.refund"),
  validate(z.object({ params: orderRef, body: z.object({ note: z.string().min(1).max(1000) }).strict() })),
  audit("return_reject", "order"),
  asyncHandler(async (req, res) => {
    res.json(service.presentOrder(req, await service.rejectReturn(req, req.params.id, req.body.note)));
  })
);
router.post(
  "/:id/return/approve",
  authorizeAny("returns.manage", "orders.refund"),
  validate(z.object({ params: orderRef, body: z.object({ note }).strict() })),
  audit("return_approve", "order"),
  asyncHandler(async (req, res) => {
    res.json(service.presentOrder(req, await service.approveReturn(req, req.params.id, req.body.note)));
  })
);
router.post(
  "/:id/return/receive",
  authorizeAny("returns.manage", "orders.refund"),
  validate(
    z.object({
      params: orderRef,
      body: z
        .object({
          note,
          items: receiveItems,
          qcNote: z.string().max(1000).optional(),
          qcPhotos: z.array(objectId).max(10).optional(),
          qcDisposition: z.enum(["return_to_buyer", "hold"]).optional(),
        })
        .strict(),
    })
  ),
  audit("return_receive", "order"),
  asyncHandler(async (req, res) => {
    res.json(service.presentOrder(req, await service.receiveReturn(req, req.params.id, req.body)));
  })
);
/** Phase 6: the seller records that the approved return could not be picked up (closes it as pickup_failed). */
router.post(
  "/:id/return/pickup-failed",
  authorizeAny("returns.manage", "orders.refund"),
  validate(z.object({ params: orderRef, body: z.object({ note: z.string().trim().min(3).max(500) }).strict() })),
  audit("return_pickup_failed", "order"),
  asyncHandler(async (req, res) => {
    res.json(service.presentOrder(req, await service.returnPickupFailed(req, req.params.id, req.body)));
  })
);
router.post(
  "/:id/status",
  authorizeAny("orders.update", "orders.cancel", "orders.refund"),
  validate(
    z.object({
      params: orderRef,
      body: z
        .object({
          status: z.enum(ORDER_STATUS_LIST),
          note,
          trackingNumber: z.string().max(80).optional(),
          carrier: z.string().max(80).optional(),
          /** returned_to_origin only: per-line damaged units ({ itemId, damagedQty }). */
          items: damagedItems,
        })
        .strict(),
    })
  ),
  audit("status", "order"),
  asyncHandler(async (req, res) => {
    res.json(
      service.presentOrder(req, await service.updateStatus(req, req.params.id, req.body.status, req.body.note, {
        trackingNumber: req.body.trackingNumber,
        carrier: req.body.carrier,
        items: req.body.items,
      }))
    );
  })
);
router.patch(
  "/:id",
  authorize("orders.update"),
  validate(z.object({ params: orderRef, body: z.object({ sellerNotes: z.string().max(2000) }).strict() })),
  audit("update", "order"),
  asyncHandler(async (req, res) => {
    res.json(service.presentOrder(req, await service.updateNotes(req, req.params.id, req.body)));
  })
);
router.post(
  "/:id/reorder",
  authorize("orders.create"),
  validate(z.object({ params: orderRef })),
  asyncHandler(async (req, res) => {
    res.json(await service.reorder(req, req.params.id));
  })
);

export default router;
