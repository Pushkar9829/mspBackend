/**
 * Marketplace tax reports + seller statements (p4-tax), all built from the seller ledger
 * (SellerLedgerEntry, owned by p4-payouts):
 *  - GSTR-8 (monthly, per seller GSTIN): taxable supplies, returns, net, TCS IGST/CGST/SGST from
 *    tcs / tcs_reversal entries (data { base, supplyType, igst, cgst, sgst }).
 *  - TDS 194-O (quarterly, per PAN): gross (tds / tds_reversal data.base) and TDS.
 *  - Seller monthly statement: opening balance, every ledger line, closing balance, TCS/TDS.
 *  - Seller tax summary per financial year: TCS by month, TDS by quarter.
 * Periods are calendar months / quarters in IST (Asia/Kolkata), by entry createdAt.
 */
import mongoose from "mongoose";
import { SellerLedgerEntry } from "./models.js";
import { Tenant } from "../tenants/tenant.model.js";
import { Order } from "../orders/order.model.js";
import { AppError } from "../../utils/AppError.js";
import { withholdingFor, withholdingForRefund, taxSettings } from "./tax.js";
import { renderStatementPdf } from "./statementPdf.js";

const IST_OFFSET_MS = 330 * 60 * 1000;

/** UTC instant of 00:00 IST on y-m-d (m 1-12, may overflow). */
export function istMidnight(y, m, d = 1) {
  return new Date(Date.UTC(y, m - 1, d) - IST_OFFSET_MS);
}

/** "YYYY-MM" -> { from, to, label } (to exclusive). */
export function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new AppError(400, "month must be YYYY-MM", "VALIDATION_ERROR");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { from: istMidnight(y, mo, 1), to: istMidnight(y, mo + 1, 1), label: `${m[1]}-${m[2]}` };
}

/** "YYYY-Qn" (calendar year of the quarter's months, Indian FY quarters: Q1 Apr-Jun ... Q4 Jan-Mar). */
export function quarterRange(quarter) {
  const m = /^(\d{4})-Q([1-4])$/i.exec(String(quarter || ""));
  if (!m) throw new AppError(400, "quarter must be YYYY-Qn (FY start year, Q1 = Apr-Jun)", "VALIDATION_ERROR");
  const fyStart = Number(m[1]);
  const q = Number(m[2]);
  const startMonth = 4 + (q - 1) * 3; // 4, 7, 10, 13 (= Jan next year)
  return {
    from: istMidnight(fyStart, startMonth, 1),
    to: istMidnight(fyStart, startMonth + 3, 1),
    label: `${fyStart}-Q${q}`,
    financialYear: `${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")}`,
  };
}

/** "2026-27" -> { from, to, startYear }. */
export function fyRange(fy) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(fy || ""));
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new AppError(400, "fy must look like 2026-27", "VALIDATION_ERROR");
  const y = Number(m[1]);
  return { from: istMidnight(y, 4, 1), to: istMidnight(y + 1, 4, 1), startYear: y, label: m[0] };
}

/** IST "YYYY-MM-DD HH:mm:ss" of a date (statement CSV; the column header says IST). */
export function istDateTime(date) {
  const d = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** IST "YYYY-MM" of a date. */
export function istMonthKey(date) {
  const d = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const rupees = (paise) => Math.round(Number(paise) || 0) / 100;
const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));

/** PAN of a store: KYC PAN, else characters 3-12 of the GSTIN. */
export function panOf(tenant) {
  const pan = String(tenant?.kyc?.pan || "").toUpperCase().trim();
  if (pan) return pan;
  const gstin = gstinOf(tenant);
  return gstin.length === 15 ? gstin.slice(2, 12) : "";
}

export function gstinOf(tenant) {
  return String(tenant?.businessProfile?.gstin || tenant?.kyc?.gstin || "").toUpperCase().trim();
}

/**
 * Withholding components of a tcs / tds (or reversal) entry. Uses entry.data when the recorder
 * stored it; otherwise recomputes from the order (base + split) so older / partial rows still
 * report correctly.
 */
async function componentsOf(entry, orderCache, settings) {
  const data = entry.data || {};
  const abs = Math.abs(Number(entry.amountPaise) || 0);
  if (entry.kind === "tcs" || entry.kind === "tcs_reversal") {
    if (data.base != null && (data.igst != null || data.cgst != null)) {
      return { base: Number(data.base) || 0, igst: Number(data.igst) || 0, cgst: Number(data.cgst) || 0, sgst: Number(data.sgst) || 0, total: abs };
    }
    const order = await loadOrder(entry.orderId, orderCache);
    const w = order ? (entry.kind === "tcs" ? withholdingFor(order, settings) : withholdingForRefund(order, { taxableValuePaise: data.base || 0 }, settings)) : null;
    const supplyType = data.supplyType || w?.supplyType || "inter";
    const base = data.base != null ? Number(data.base) : w?.base || 0;
    if (supplyType === "intra") {
      const cgst = Math.round(abs / 2);
      return { base, igst: 0, cgst, sgst: abs - cgst, total: abs };
    }
    return { base, igst: abs, cgst: 0, sgst: 0, total: abs };
  }
  // tds / tds_reversal
  let base = data.base != null ? Number(data.base) : null;
  if (base == null) {
    const order = await loadOrder(entry.orderId, orderCache);
    base = entry.kind === "tds" && order ? withholdingFor(order, settings).base : 0;
  }
  return { base, total: abs };
}

async function loadOrder(orderId, cache) {
  if (!orderId) return null;
  const key = String(orderId);
  if (!cache.has(key)) cache.set(key, await Order.findById(orderId).lean());
  return cache.get(key);
}

async function tenantsById(ids) {
  const rows = await Tenant.find({ _id: { $in: [...ids].map(oid) } }, { name: 1, slug: 1, businessProfile: 1, kyc: 1, pickupAddress: 1 }).lean();
  return new Map(rows.map((t) => [String(t._id), t]));
}

/* ------------------------------------------------------------------ GSTR-8 */

/**
 * GSTR-8 for a month: one row per seller GSTIN (stores without a GSTIN are grouped under their
 * store id with `gstin: ""` and flagged). Amounts in rupees (and paise fields for exact maths).
 */
export async function gstr8(month) {
  const range = monthRange(month);
  const settings = await taxSettings();
  const entries = await SellerLedgerEntry.find({
    kind: { $in: ["tcs", "tcs_reversal"] },
    createdAt: { $gte: range.from, $lt: range.to },
  })
    .sort({ createdAt: 1 })
    .lean();
  const cache = new Map();
  const byTenant = new Map();
  for (const e of entries) {
    const c = await componentsOf(e, cache, settings);
    const key = String(e.tenantId);
    const row =
      byTenant.get(key) ||
      { tenantId: key, grossPaise: 0, returnsPaise: 0, tcs: { igst: 0, cgst: 0, sgst: 0 }, orders: new Set(), entries: 0 };
    const sign = e.kind === "tcs" ? 1 : -1;
    if (sign > 0) row.grossPaise += c.base;
    else row.returnsPaise += c.base;
    row.tcs.igst += sign * c.igst;
    row.tcs.cgst += sign * c.cgst;
    row.tcs.sgst += sign * c.sgst;
    if (e.orderId) row.orders.add(String(e.orderId));
    row.entries += 1;
    byTenant.set(key, row);
  }
  const tenants = await tenantsById(byTenant.keys());
  const rows = [...byTenant.values()].map((r) => {
    const t = tenants.get(r.tenantId) || {};
    const netPaise = r.grossPaise - r.returnsPaise;
    const tcsTotal = r.tcs.igst + r.tcs.cgst + r.tcs.sgst;
    return {
      tenantId: r.tenantId,
      storeName: t.name || "",
      legalName: t.kyc?.legalName || t.businessProfile?.legalName || t.name || "",
      gstin: gstinOf(t),
      missingGstin: !gstinOf(t),
      orders: r.orders.size,
      grossTaxable: rupees(r.grossPaise),
      returns: rupees(r.returnsPaise),
      netTaxable: rupees(netPaise),
      tcsIgst: rupees(r.tcs.igst),
      tcsCgst: rupees(r.tcs.cgst),
      tcsSgst: rupees(r.tcs.sgst),
      tcsTotal: rupees(tcsTotal),
      paise: { gross: r.grossPaise, returns: r.returnsPaise, net: netPaise, igst: r.tcs.igst, cgst: r.tcs.cgst, sgst: r.tcs.sgst, total: tcsTotal },
    };
  });
  rows.sort((a, b) => (a.gstin || "~").localeCompare(b.gstin || "~") || a.storeName.localeCompare(b.storeName));
  const sum = (k) => rows.reduce((s, r) => s + r.paise[k], 0);
  return {
    month: range.label,
    from: range.from,
    to: range.to,
    rates: { tcsRate: settings.tcsRate },
    rows,
    totals: {
      sellers: rows.length,
      grossTaxable: rupees(sum("gross")),
      returns: rupees(sum("returns")),
      netTaxable: rupees(sum("net")),
      tcsIgst: rupees(sum("igst")),
      tcsCgst: rupees(sum("cgst")),
      tcsSgst: rupees(sum("sgst")),
      tcsTotal: rupees(sum("total")),
    },
  };
}

/* ------------------------------------------------------------------ TDS 194-O */

export async function tdsReport(quarter) {
  const range = quarterRange(quarter);
  const settings = await taxSettings();
  const entries = await SellerLedgerEntry.find({
    kind: { $in: ["tds", "tds_reversal"] },
    createdAt: { $gte: range.from, $lt: range.to },
  }).lean();
  const cache = new Map();
  const byTenant = new Map();
  for (const e of entries) {
    const c = await componentsOf(e, cache, settings);
    const key = String(e.tenantId);
    const row = byTenant.get(key) || { grossPaise: 0, returnsPaise: 0, tdsPaise: 0 };
    if (e.kind === "tds") {
      row.grossPaise += c.base;
      row.tdsPaise += c.total;
    } else {
      row.returnsPaise += c.base;
      row.tdsPaise -= c.total;
    }
    byTenant.set(key, row);
  }
  const tenants = await tenantsById(byTenant.keys());
  // Group stores by PAN (one deductee can own several stores / GSTINs).
  const byPan = new Map();
  for (const [tenantId, r] of byTenant) {
    const t = tenants.get(tenantId) || {};
    const pan = panOf(t);
    const key = pan || `store:${tenantId}`;
    const row =
      byPan.get(key) ||
      { pan, missingPan: !pan, legalName: t.kyc?.legalName || t.businessProfile?.legalName || t.name || "", stores: [], grossPaise: 0, returnsPaise: 0, tdsPaise: 0 };
    row.stores.push({ tenantId, name: t.name || "", gstin: gstinOf(t) });
    row.grossPaise += r.grossPaise;
    row.returnsPaise += r.returnsPaise;
    row.tdsPaise += r.tdsPaise;
    byPan.set(key, row);
  }
  const rows = [...byPan.values()]
    .map((r) => ({
      pan: r.pan,
      missingPan: r.missingPan,
      legalName: r.legalName,
      stores: r.stores,
      grossSales: rupees(r.grossPaise),
      returns: rupees(r.returnsPaise),
      netSales: rupees(r.grossPaise - r.returnsPaise),
      tds: rupees(r.tdsPaise),
      paise: { gross: r.grossPaise, returns: r.returnsPaise, net: r.grossPaise - r.returnsPaise, tds: r.tdsPaise },
    }))
    .sort((a, b) => (a.pan || "~").localeCompare(b.pan || "~"));
  const sum = (k) => rows.reduce((s, r) => s + r.paise[k], 0);
  return {
    quarter: range.label,
    financialYear: range.financialYear,
    from: range.from,
    to: range.to,
    rates: { tdsRate: settings.tdsRate },
    rows,
    totals: { deductees: rows.length, grossSales: rupees(sum("gross")), returns: rupees(sum("returns")), netSales: rupees(sum("net")), tds: rupees(sum("tds")) },
  };
}

/* ------------------------------------------------------------------ CSV */

function csvCell(v) {
  const s = v == null ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s; // no formula injection
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function gstr8Csv(report) {
  return toCsv(
    ["Month", "GSTIN", "Legal name", "Store", "Orders", "Gross taxable", "Returns", "Net taxable", "TCS IGST", "TCS CGST", "TCS SGST", "TCS total"],
    report.rows.map((r) => [report.month, r.gstin, r.legalName, r.storeName, r.orders, r.grossTaxable.toFixed(2), r.returns.toFixed(2), r.netTaxable.toFixed(2), r.tcsIgst.toFixed(2), r.tcsCgst.toFixed(2), r.tcsSgst.toFixed(2), r.tcsTotal.toFixed(2)])
  );
}

export function tdsCsv(report) {
  return toCsv(
    ["Quarter", "PAN", "Legal name", "Stores", "Gross sales", "Returns", "Net sales", "TDS"],
    report.rows.map((r) => [report.quarter, r.pan, r.legalName, r.stores.map((s) => s.gstin || s.name).join(" | "), r.grossSales.toFixed(2), r.returns.toFixed(2), r.netSales.toFixed(2), r.tds.toFixed(2)])
  );
}

/* ------------------------------------------------------------------ statements */

const KIND_LABELS = {
  sale: "Sale",
  platform_fee: "Platform fee",
  partner_fee: "Courier / partner fee",
  gateway_fee: "Payment gateway fee",
  route_fee: "Route transfer fee",
  tcs: "GST TCS",
  tds: "TDS 194-O",
  refund: "Refund",
  tcs_reversal: "GST TCS reversal",
  tds_reversal: "TDS reversal",
  collected_by_seller: "Collected by seller",
  credit_repayment: "Credit repayment",
  subscription_netting: "Subscription dues netted",
  payout: "Payout",
  adjustment: "Adjustment",
};

/** Monthly statement of one store. Amounts in rupees (+ paise fields). */
export async function sellerStatement(tenantId, month) {
  const range = monthRange(month);
  const tid = oid(tenantId);
  const tenant = await Tenant.findById(tid, { name: 1, slug: 1, businessProfile: 1, kyc: 1 }).lean();
  if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
  const [openingAgg] = await SellerLedgerEntry.aggregate([
    { $match: { tenantId: tid, createdAt: { $lt: range.from } } },
    { $group: { _id: null, total: { $sum: "$amountPaise" } } },
  ]);
  const openingPaise = openingAgg?.total || 0;
  const entries = await SellerLedgerEntry.find({ tenantId: tid, createdAt: { $gte: range.from, $lt: range.to } })
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  const orderIds = [...new Set(entries.filter((e) => e.orderId && !e.orderNumber).map((e) => String(e.orderId)))];
  const orderNos = new Map(
    orderIds.length ? (await Order.find({ _id: { $in: orderIds.map(oid) } }, { orderNumber: 1 }).lean()).map((o) => [String(o._id), o.orderNumber]) : []
  );
  let running = openingPaise;
  const byKind = {};
  const totals = { creditsPaise: 0, debitsPaise: 0, tcsPaise: 0, tdsPaise: 0, heldPaise: 0 };
  const lines = entries.map((e) => {
    const amt = Number(e.amountPaise) || 0;
    running += amt;
    byKind[e.kind] = (byKind[e.kind] || 0) + amt;
    if (amt >= 0) totals.creditsPaise += amt;
    else totals.debitsPaise += -amt;
    if (e.kind === "tcs") totals.tcsPaise += -amt;
    if (e.kind === "tcs_reversal") totals.tcsPaise -= amt;
    if (e.kind === "tds") totals.tdsPaise += -amt;
    if (e.kind === "tds_reversal") totals.tdsPaise -= amt;
    return {
      id: e._id,
      date: e.createdAt,
      orderId: e.orderId || null,
      orderNumber: e.orderNumber || (e.orderId ? orderNos.get(String(e.orderId)) || "" : ""),
      kind: e.kind,
      kindLabel: KIND_LABELS[e.kind] || e.kind,
      memo: e.memo || "",
      amount: rupees(amt),
      amountPaise: amt,
      balance: rupees(running),
      balancePaise: running,
      held: e.availableAt == null || new Date(e.availableAt) > range.to,
      payoutId: e.payoutId || null,
    };
  });
  // Held at month end: entries created before the end whose money was not yet available then.
  const [heldAgg] = await SellerLedgerEntry.aggregate([
    { $match: { tenantId: tid, createdAt: { $lt: range.to }, $or: [{ availableAt: null }, { availableAt: { $gte: range.to } }] } },
    { $group: { _id: null, total: { $sum: "$amountPaise" } } },
  ]);
  totals.heldPaise = heldAgg?.total || 0;
  return {
    month: range.label,
    from: range.from,
    to: range.to,
    store: { id: tenant._id, name: tenant.name, legalName: tenant.kyc?.legalName || tenant.businessProfile?.legalName || tenant.name, gstin: gstinOf(tenant), pan: panOf(tenant) },
    openingBalance: rupees(openingPaise),
    closingBalance: rupees(running),
    openingBalancePaise: openingPaise,
    closingBalancePaise: running,
    totals: {
      credits: rupees(totals.creditsPaise),
      debits: rupees(totals.debitsPaise),
      tcs: rupees(totals.tcsPaise),
      tds: rupees(totals.tdsPaise),
      heldAtClose: rupees(totals.heldPaise),
      byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, rupees(v)])),
    },
    lines,
  };
}

export function statementCsv(st) {
  const head = toCsv(["Statement", st.store.name, st.store.gstin, st.month], [
    ["Opening balance", "", "", st.openingBalance.toFixed(2)],
  ]);
  const body = toCsv(
    ["Date (IST)", "Order", "Type", "Memo", "Amount", "Balance", "Held"],
    st.lines.map((l) => [istDateTime(l.date), l.orderNumber, l.kindLabel, l.memo, l.amount.toFixed(2), l.balance.toFixed(2), l.held ? "yes" : ""])
  );
  const tail = toCsv(["Closing balance", "", "", st.closingBalance.toFixed(2)], [
    ["GST TCS withheld", "", "", st.totals.tcs.toFixed(2)],
    ["TDS 194-O withheld", "", "", st.totals.tds.toFixed(2)],
    ["Held at month end", "", "", st.totals.heldAtClose.toFixed(2)],
  ]);
  return head + body + tail;
}

export function statementPdf(st) {
  return renderStatementPdf(st);
}

/* ------------------------------------------------------------------ seller tax summary */

/** TCS by month and TDS by quarter of one store for a financial year (e.g. "2026-27"). */
export async function sellerTaxSummary(tenantId, fy) {
  const range = fyRange(fy);
  const settings = await taxSettings();
  const entries = await SellerLedgerEntry.find({
    tenantId: oid(tenantId),
    kind: { $in: ["tcs", "tcs_reversal", "tds", "tds_reversal"] },
    createdAt: { $gte: range.from, $lt: range.to },
  }).lean();
  const months = [];
  for (let i = 0; i < 12; i += 1) {
    const y = range.startYear + (i >= 9 ? 1 : 0);
    const m = ((3 + i) % 12) + 1;
    months.push({ month: `${y}-${String(m).padStart(2, "0")}`, taxable: 0, igst: 0, cgst: 0, sgst: 0, tcs: 0 });
  }
  const quarters = [1, 2, 3, 4].map((q) => ({ quarter: `${range.startYear}-Q${q}`, gross: 0, tds: 0 }));
  const cache = new Map();
  for (const e of entries) {
    const c = await componentsOf(e, cache, settings);
    const key = istMonthKey(e.createdAt);
    const idx = months.findIndex((m) => m.month === key);
    if (idx < 0) continue;
    if (e.kind === "tcs" || e.kind === "tcs_reversal") {
      const sign = e.kind === "tcs" ? 1 : -1;
      const row = months[idx];
      row.taxable += sign * c.base;
      row.igst += sign * c.igst;
      row.cgst += sign * c.cgst;
      row.sgst += sign * c.sgst;
      row.tcs += sign * c.total;
    } else {
      const sign = e.kind === "tds" ? 1 : -1;
      const q = quarters[Math.floor(idx / 3)];
      q.gross += sign * c.base;
      q.tds += sign * c.total;
    }
  }
  const tcsMonths = months.map((m) => ({ month: m.month, taxable: rupees(m.taxable), igst: rupees(m.igst), cgst: rupees(m.cgst), sgst: rupees(m.sgst), tcs: rupees(m.tcs) }));
  const tdsQuarters = quarters.map((q) => ({ quarter: q.quarter, gross: rupees(q.gross), tds: rupees(q.tds) }));
  return {
    financialYear: range.label,
    rates: { tcsRate: settings.tcsRate, tdsRate: settings.tdsRate },
    tcs: { months: tcsMonths, total: rupees(months.reduce((s, m) => s + m.tcs, 0)) },
    tds: { quarters: tdsQuarters, total: rupees(quarters.reduce((s, q) => s + q.tds, 0)) },
  };
}
