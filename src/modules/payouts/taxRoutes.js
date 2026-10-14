import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant, requireStaff, requireTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as reports from "./taxReports.js";
import * as recon from "./reconciliation.js";

/**
 * p4-tax HTTP surface:
 *   /api/v1/admin/tax                 GSTR-8 (month) + TDS 194-O (quarter), JSON or CSV (payouts.manage)
 *   /api/v1/admin/reconciliation      Razorpay settlement reconciliation runs (payouts.manage)
 *   /api/v1/admin/cod-remittances     courier COD remittances + unremitted list (payouts.manage)
 *   /api/v1/admin/payouts/sellers/:tenantId/statements/:month, /tax   (payouts.manage)
 *   /api/v1/payouts/me/statements/:month, /payouts/me/tax             (store staff, payouts.view)
 */

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM");
const format = z.enum(["json", "csv", "pdf"]).optional();
const fy = z.string().regex(/^\d{4}-\d{2}$/, "e.g. 2026-27").optional();

function currentFy() {
  const d = new Date(Date.now() + 330 * 60 * 1000);
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

function sendCsv(res, filename, csv) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(csv);
}

async function sendStatement(req, res, tenantId) {
  const st = await reports.sellerStatement(tenantId, req.params.month);
  const fmt = req.query.format || "json";
  const base = `statement-${String(st.store.name || "store").replace(/[^A-Za-z0-9-]+/g, "_").slice(0, 40)}-${st.month}`;
  if (fmt === "csv") return sendCsv(res, `${base}.csv`, reports.statementCsv(st));
  if (fmt === "pdf") {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.pdf"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(reports.statementPdf(st));
  }
  return res.json(st);
}

/* ------------------------------------------------------------------ admin: tax reports */

export const adminTaxRouter = Router();
adminTaxRouter.use(authenticate, authorize("payouts.manage"));
adminTaxRouter.get(
  "/gstr8",
  validate(z.object({ query: z.object({ month, format: z.enum(["json", "csv"]).optional() }) })),
  asyncHandler(async (req, res) => {
    const report = await reports.gstr8(req.query.month);
    if (req.query.format === "csv") return sendCsv(res, `gstr8-${report.month}.csv`, reports.gstr8Csv(report));
    return res.json(report);
  })
);
adminTaxRouter.get(
  "/tds",
  validate(z.object({ query: z.object({ quarter: z.string().regex(/^\d{4}-Q[1-4]$/i, "YYYY-Qn"), format: z.enum(["json", "csv"]).optional() }) })),
  asyncHandler(async (req, res) => {
    const report = await reports.tdsReport(req.query.quarter);
    if (req.query.format === "csv") return sendCsv(res, `tds-194o-${report.quarter}.csv`, reports.tdsCsv(report));
    return res.json(report);
  })
);

/* ------------------------------------------------------------------ admin: reconciliation */

export const adminReconciliationRouter = Router();
adminReconciliationRouter.use(authenticate, authorize("payouts.manage"));
adminReconciliationRouter.get(
  "/runs",
  validate(z.object({ query: z.object({ page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }) })),
  asyncHandler(async (req, res) => res.json(await recon.listRuns(req.query)))
);
adminReconciliationRouter.post(
  "/runs",
  audit("reconcile", "reconciliation"),
  validate(z.object({ body: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD") }).strict() })),
  asyncHandler(async (req, res) => {
    const run = await recon.runReconciliation(req.body.date, { source: "admin", actorId: req.user?._id });
    res.status(201).json(await recon.getRun(run._id));
  })
);
adminReconciliationRouter.get(
  "/runs/:id",
  validate(z.object({ params: z.object({ id: objectId }), query: z.object({ status: z.string().max(60).optional(), problems: z.enum(["true", "false"]).optional() }) })),
  asyncHandler(async (req, res) => res.json(await recon.getRun(req.params.id, req.query)))
);
adminReconciliationRouter.post(
  "/runs/:id/items/:itemId/resolve",
  audit("resolve", "reconciliation"),
  validate(z.object({ params: z.object({ id: objectId, itemId: objectId }), body: z.object({ note: z.string().trim().min(1).max(1000) }).strict() })),
  asyncHandler(async (req, res) => res.json(await recon.resolveItem(req.params.id, req.params.itemId, req.body, req.user?._id)))
);

/* ------------------------------------------------------------------ admin: COD remittances */

export const adminCodRemittanceRouter = Router();
adminCodRemittanceRouter.use(authenticate, authorize("payouts.manage"));
adminCodRemittanceRouter.get(
  "/unremitted",
  validate(
    z.object({
      query: z.object({
        carrier: z.string().max(40).optional(),
        olderThanDays: z.coerce.number().int().min(0).max(365).optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => res.json(await recon.unremittedCod(req.query)))
);
adminCodRemittanceRouter.get(
  "/",
  validate(z.object({ query: z.object({ carrier: z.string().max(40).optional(), page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }) })),
  asyncHandler(async (req, res) => res.json(await recon.listCodRemittances(req.query)))
);
adminCodRemittanceRouter.post(
  "/",
  audit("record", "cod_remittance"),
  validate(
    z.object({
      body: z
        .object({
          carrier: z.string().trim().min(1).max(40),
          reference: z.string().trim().min(1).max(120),
          receivedAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
          note: z.string().max(500).optional(),
          rows: z
            .array(
              z
                .object({
                  orderNumber: z.string().trim().max(64).optional(),
                  awb: z.string().trim().max(64).optional(),
                  amount: z.number().finite().min(0).max(10_000_000),
                })
                .strict()
                .refine((r) => r.orderNumber || r.awb, { message: "orderNumber or awb is required" })
            )
            .min(1)
            .max(2000),
        })
        .strict(),
    })
  ),
  asyncHandler(async (req, res) => res.status(201).json(await recon.recordCodRemittance(req.body, req.user?._id)))
);

/* ------------------------------------------------------------------ admin: seller statements */

export const adminStatementRouter = Router();
adminStatementRouter.use("/sellers", authenticate, authorize("payouts.manage"));
adminStatementRouter.get(
  "/sellers/:tenantId/statements/:month",
  validate(z.object({ params: z.object({ tenantId: objectId, month }), query: z.object({ format }) })),
  asyncHandler(async (req, res) => sendStatement(req, res, req.params.tenantId))
);
adminStatementRouter.get(
  "/sellers/:tenantId/tax",
  validate(z.object({ params: z.object({ tenantId: objectId }), query: z.object({ fy }) })),
  asyncHandler(async (req, res) => res.json(await reports.sellerTaxSummary(req.params.tenantId, req.query.fy || currentFy())))
);

/* ------------------------------------------------------------------ seller */

export const sellerTaxRouter = Router();
sellerTaxRouter.use("/me/statements", authenticate, resolveTenant, requireStaff, requireTenant, authorize("payouts.view"));
sellerTaxRouter.use("/me/tax", authenticate, resolveTenant, requireStaff, requireTenant, authorize("payouts.view"));
sellerTaxRouter.get(
  "/me/statements/:month",
  validate(z.object({ params: z.object({ month }), query: z.object({ format }) })),
  asyncHandler(async (req, res) => sendStatement(req, res, req.tenantId))
);
sellerTaxRouter.get(
  "/me/tax",
  validate(z.object({ query: z.object({ fy }) })),
  asyncHandler(async (req, res) => res.json(await reports.sellerTaxSummary(req.tenantId, req.query.fy || currentFy())))
);
