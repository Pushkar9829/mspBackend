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
import { ORDER_STATUS_LIST } from "./statuses.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
/** Order id or order number. */
const orderRef = z.object({ id: z.string().min(1).max(64) });
const note = z.string().max(1000).optional();

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

/** Refund intents (default status=failed) across the store's orders. Staff only. */
router.get(
  "/refunds",
  authorizeAny("orders.refund", "orders.update"),
  requireStaff,
  asyncHandler(async (req, res) => {
    res.json(await service.listRefunds(req));
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
  const [order, commerce] = await Promise.all([service.getOrder(req, req.params.id), getCommerceSettings()]);
  res.json({
    ...order.toObject(),
    returnUntil: service.returnDeadline(order, commerce),
    returnWindowDays: commerce.returnWindowDays,
    totals: service.orderTotals(order),
    allowedActions: service.allowedActions(req, order, commerce),
  });
}));

router.post(
  "/:id/cancel",
  authorizeAny("orders.cancel", "orders.update"),
  validate(z.object({ params: orderRef, body: z.object({ note }).strict() })),
  audit("cancel", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.cancel(req, req.params.id, req.body.note));
  })
);
router.post(
  "/:id/refund",
  authorize("orders.refund"),
  validate(z.object({ params: orderRef, body: z.object({ note }).strict() })),
  audit("refund", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.refund(req, req.params.id, req.body.note));
  })
);
router.post(
  "/:id/return",
  authorize("orders.view"),
  validate(z.object({ params: orderRef, body: z.object({ reason: z.string().min(1).max(120), note }).strict() })),
  audit("return_request", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.requestReturn(req, req.params.id, req.body));
  })
);
router.post(
  "/:id/return/reject",
  authorizeAny("returns.manage", "orders.refund"),
  validate(z.object({ params: orderRef, body: z.object({ note: z.string().min(1).max(1000) }).strict() })),
  audit("return_reject", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.rejectReturn(req, req.params.id, req.body.note));
  })
);
router.post(
  "/:id/return/approve",
  authorizeAny("returns.manage", "orders.refund"),
  validate(z.object({ params: orderRef, body: z.object({ note }).strict() })),
  audit("return_approve", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.approveReturn(req, req.params.id, req.body.note));
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
          items: z.array(z.object({ itemId: objectId, damagedQty: z.number().int().min(0) }).strict()).max(200).optional(),
        })
        .strict(),
    })
  ),
  audit("return_receive", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.receiveReturn(req, req.params.id, req.body));
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
        })
        .strict(),
    })
  ),
  audit("status", "order"),
  asyncHandler(async (req, res) => {
    res.json(
      await service.updateStatus(req, req.params.id, req.body.status, req.body.note, {
        trackingNumber: req.body.trackingNumber,
        carrier: req.body.carrier,
      })
    );
  })
);
router.patch(
  "/:id",
  authorize("orders.update"),
  validate(z.object({ params: orderRef, body: z.object({ sellerNotes: z.string().max(2000) }).strict() })),
  audit("update", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.updateNotes(req, req.params.id, req.body));
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
