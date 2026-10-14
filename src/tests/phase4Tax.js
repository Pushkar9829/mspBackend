/**
 * Phase 4 (p4-tax): withholding tax maths, split invoices (seller + platform series) with platform
 * credit notes, old combined invoices untouched, GSTR-8 / TDS 194-O reports + CSV, seller
 * statements (opening / closing), Razorpay settlement reconciliation (faked), COD remittances.
 *
 * Local throwaway DB only:
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_p4t?replicaSet=rs0" node src/tests/phase4Tax.js
 */
import express from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";

if (!/127\.0\.0\.1:27027\/msp_test_p4t(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_p4t database");
  process.exit(2);
}

const { setup, teardown, makeStore, makeBuyer, check, finish } = await import("./commerceFixtures.js");
const { requestId } = await import("../middleware/requestId.js");
const { notFound, errorHandler } = await import("../middleware/error.js");
const { signAccessToken } = await import("../utils/tokens.js");
const { ensureSystemRoles } = await import("../seeds/index.js");
const { default: v1 } = await import("../routes/v1.js");
const { User } = await import("../modules/users/user.model.js");
const { Tenant } = await import("../modules/tenants/tenant.model.js");
const { Settings } = await import("../modules/settings/settings.model.js");
const { invalidateSettingCache } = await import("../modules/settings/service.js");
const { addItem, getOrCreateCart, quoteCart } = await import("../modules/cart/service.js");
const { checkout } = await import("../modules/checkout/service.js");
const { confirmOrder, cancelOrder, advanceOrder, approveReturn, receiveReturn } = await import("../modules/orders/lifecycle.js");
const orders = await import("../modules/orders/service.js");
const { Order } = await import("../modules/orders/order.model.js");
const { Invoice, CreditNote } = await import("../modules/invoices/invoice.model.js");
const { PlatformOrderInvoice, PlatformCreditNote } = await import("../modules/invoices/platformInvoice.model.js");
const { buildInvoiceLines, sumTotals } = await import("../modules/invoices/service.js");
const { platformFeeLines } = await import("../modules/invoices/platform.js");
const tax = await import("../modules/payouts/tax.js");
const reports = await import("../modules/payouts/taxReports.js");
const recon = await import("../modules/payouts/reconciliation.js");
const { ReconciliationRun } = await import("../modules/payouts/reconciliation.model.js");
const { SellerLedgerEntry } = await import("../modules/payouts/models.js");
const { setRazorpayClient } = await import("../modules/checkout/razorpayApi.js");
const { runJob } = await import("../jobs/index.js");
const { gstinCheckChar } = await import("../utils/gstin.js");

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;
const NUM16 = /^[A-Z0-9]{1,4}\/\d{4}\/\d{6}$/;
const CN16 = /^[A-Z0-9]{1,4}\/\d{4}\/C\d{5}$/;
function gstin(stateCode, pan = "AAPFU0939F") {
  const first14 = `${stateCode}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
}

const fakeRzp = await setup();
const roles = await ensureSystemRoles();
for (const name of mongoose.modelNames()) await mongoose.model(name).createIndexes().catch(() => {});
await Settings.insertMany([
  { scope: "platform", tenantId: null, key: "platform.feeEnabled", value: true },
  { scope: "platform", tenantId: null, key: "platform.feeAmount", value: 10 },
  { scope: "platform", tenantId: null, key: "platform.legalName", value: "MSP Marketplace Pvt Ltd" },
  { scope: "platform", tenantId: null, key: "platform.gstin", value: gstin("27", "AAACM1234A") },
  { scope: "platform", tenantId: null, key: "platform.state", value: "Maharashtra" },
  { scope: "platform", tenantId: null, key: "platform.orderInvoicePrefix", value: "MSPF" },
]);
invalidateSettingCache();

const app = express();
app.use(requestId);
app.use(express.json());
app.use("/api/v1", v1);
app.use(notFound);
app.use(errorHandler);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
async function call(method, url, { token, json, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (json !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(base + "/api/v1" + url, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}
const tokenFor = async (user) => {
  await User.updateOne({ _id: user._id, status: "pending" }, { $set: { status: "active", emailVerified: true } });
  const fresh = await User.findById(user._id).lean();
  return signAccessToken({ sub: String(fresh._id), tenantId: fresh.tenantId ? String(fresh.tenantId) : null, tv: fresh.tokenVersion || 0 });
};
const admin = await User.create({ name: "Platform", email: "pa@p4t.test", passwordHash: "x", roleId: roles.super_admin._id, status: "active", emailVerified: true });
const ADMIN = await tokenFor(admin);

async function place(buyer) {
  const cart = await getOrCreateCart(buyer.user._id);
  const quote = await quoteCart(cart, buyer.user._id, buyer.address);
  const { orders: placed } = await checkout({
    user: buyer.user,
    addressId: buyer.address._id,
    paymentMethod: "cod",
    idempotencyKey: `key-${Math.random()}`,
    expectedGrandTotal: quote.grandTotal,
  });
  return placed[0];
}
async function newOrder(store, buyer, qty = 1) {
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty });
  return place(buyer);
}

/* ------------------------------------------------------------------ 1. tax maths */
console.log("\n# withholding tax maths");
{
  const order = {
    sellerSnapshot: { state: "Maharashtra" },
    addressSnapshot: { state: "MH" },
    items: [{ taxableValue: 1000, taxRate: 18, lineSubtotal: 1180 }],
    deliveryFee: 59,
    platformFee: 10,
    partnerFee: 40,
  };
  const s = { tcsRate: 0.5, tdsRate: 0.1, tcsEnabled: true, tdsEnabled: true };
  const w = tax.withholdingFor(order, s);
  check(w.base === 105000, `base = goods 1000 + own delivery taxable 50 (no platform / partner fee) -> ${w.base}`);
  check(w.supplyType === "intra" && w.tcs.igst === 0 && w.tcs.cgst === 263 && w.tcs.sgst === 263 && w.tcs.total === 526, `intra: CGST/SGST 0.25% each rounded to paise (${JSON.stringify(w.tcs)})`);
  check(w.tds === 105, `TDS 0.1% = 105 paise (${w.tds})`);
  const inter = tax.withholdingFor({ ...order, addressSnapshot: { state: "Delhi" } }, s);
  check(inter.supplyType === "inter" && inter.tcs.igst === 525 && inter.tcs.cgst === 0 && inter.tcs.total === 525, `inter: IGST 0.5% (${inter.tcs.igst})`);
  const off = tax.withholdingFor(order, { ...s, tcsEnabled: false, tdsEnabled: false });
  check(off.tcs.total === 0 && off.tds === 0 && off.base === 105000, "disabled taxes -> zero withholding, base still reported");
  const coupon = tax.withholdingFor({ ...order, deliveryFee: 0, items: [{ lineSubtotal: 1180, couponShare: 118, taxRate: 18 }] }, s);
  check(coupon.base === 90000, `taxable value after coupon (1062 incl. 18% -> 900) = ${coupon.base}`);
  const ref = tax.withholdingForRefund(order, { taxableValuePaise: 33333 }, s);
  check(ref.tcs.cgst === 83 && ref.tcs.sgst === 83 && ref.tds === 33, `refund reversal on part of the value (${JSON.stringify(ref.tcs)}, tds ${ref.tds})`);
  const neg = tax.withholdingForRefund(order, { taxableValuePaise: -500 }, s);
  check(neg.base === 0 && neg.tcs.total === 0 && neg.tds === 0, "never negative");
  const fromSettings = await tax.taxSettings();
  check(fromSettings.tcsRate === 0.5 && fromSettings.tdsRate === 0.1 && fromSettings.tcsEnabled && fromSettings.tdsEnabled, "taxSettings() defaults 0.5 / 0.1 / enabled");
  const lines = platformFeeLines(order, "inter");
  check(lines.length === 2 && lines.find((l) => l.feeKey === "partner").hsn === "996812" && lines.find((l) => l.feeKey === "platform").hsn === "998599", "platform invoice lines: partner fee SAC 996812, platform fee SAC 998599");
}

/* ------------------------------------------------------------------ 2. split invoices */
console.log("\n# split invoices");
const storeMH = await makeStore({ stock: 50, state: "Maharashtra" });
await Tenant.updateOne({ _id: storeMH.tenant._id }, { $set: { "businessProfile.gstin": gstin("27"), "businessProfile.legalName": "MH Traders" } });
const buyerMH = await makeBuyer({ state: "Maharashtra" });
const buyerDL = await makeBuyer({ state: "Delhi" });
const buyerToken = await tokenFor({ _id: buyerMH.user._id });

let o1 = await newOrder(storeMH, buyerMH, 2);
check(o1.platformFee > 0, `order carries a platform fee (${o1.platformFee})`);
o1 = await confirmOrder(o1, null);
const inv1 = await Invoice.findOne({ orderId: o1._id });
const pinv1 = await PlatformOrderInvoice.findOne({ orderId: o1._id });
check(inv1.feeLayout === "split" && !inv1.lines.some((l) => /Platform fee/.test(l.description)), "seller invoice: split layout, no platform fee line");
check(pinv1 && NUM16.test(pinv1.invoiceNumber) && pinv1.invoiceNumber.startsWith("MSPF/") && pinv1.invoiceNumber.length <= 16, `platform invoice in its own series (${pinv1?.invoiceNumber})`);
check(pinv1.lines.length === 1 && pinv1.lines[0].hsn === "998599" && pinv1.supplyType === "intra" && near(pinv1.totals.cgst + pinv1.totals.sgst, pinv1.totals.tax), "platform fee SAC 998599, MH platform -> MH buyer: CGST + SGST");
check(near(inv1.totals.grandTotal + pinv1.totals.grandTotal, o1.total), `seller (${inv1.totals.grandTotal}) + platform (${pinv1.totals.grandTotal}) = order total ${o1.total}`);
check(pinv1.seller.legalName === "MSP Marketplace Pvt Ltd" && pinv1.buyer.state === "Maharashtra", "platform is the supplier, buyer the recipient");
const o1db = await Order.findById(o1._id).lean();
check(String(o1db.platformInvoiceId) === String(pinv1._id) && o1db.platformInvoiceNumber === pinv1.invoiceNumber, "order.platformInvoiceId / platformInvoiceNumber set");

let o2 = await newOrder(storeMH, buyerDL, 1);
o2 = await confirmOrder(o2, null);
const pinv2 = await PlatformOrderInvoice.findOne({ orderId: o2._id });
check(pinv2.supplyType === "inter" && pinv2.totals.cgst === 0 && near(pinv2.totals.igst, pinv2.totals.tax), "MH platform -> Delhi buyer: IGST");
check(pinv2.sequence === pinv1.sequence + 1, `platform series is sequential (${pinv1.sequence} -> ${pinv2.sequence})`);

// HTTP: buyer sees both documents; old single-invoice endpoint unchanged.
{
  const res = await call("GET", `/orders/${o1._id}/invoices`, { token: buyerToken });
  check(res.status === 200 && Array.isArray(res.data) && res.data.length === 2 && res.data[0].type === "seller" && res.data[1].type === "platform", `GET /orders/:id/invoices -> seller + platform (${res.status} ${res.status !== 200 ? JSON.stringify(res.data) : ""})`);
  check(res.data[1].pdf === `/api/v1/orders/${o1._id}/platform-invoice.pdf` && res.data[1].number === pinv1.invoiceNumber, "platform entry has number + pdf link");
  const single = await call("GET", `/orders/${o1._id}/invoice`, { token: buyerToken });
  check(single.status === 200 && single.data.invoiceNumber === inv1.invoiceNumber, "GET /orders/:id/invoice still returns the seller invoice");
  const pdf = await call("GET", `/orders/${o1._id}/platform-invoice.pdf`, { token: buyerToken, raw: true });
  check(pdf.status === 200 && pdf.buffer.subarray(0, 5).toString() === "%PDF-", "platform invoice PDF");
  const other = await makeBuyer({ state: "Maharashtra" });
  const denied = await call("GET", `/orders/${o1._id}/invoices`, { token: await tokenFor({ _id: other.user._id }) });
  check(denied.status === 404 || denied.status === 403, `another buyer cannot read them (${denied.status})`);
  const adminView = await call("GET", `/orders/${o1._id}/invoices`, { token: ADMIN });
  check(adminView.status === 200 && adminView.data.length === 2, "platform admin sees both");
}

// Cancel -> seller credit note (goods + own delivery) + platform credit note (fee) on the platform series.
await cancelOrder(o2, null, "buyer changed mind", { cancelledBy: "buyer" });
{
  const cn = await CreditNote.findOne({ orderId: o2._id });
  const pcn = await PlatformCreditNote.findOne({ orderId: o2._id });
  const inv2 = await Invoice.findOne({ orderId: o2._id });
  check(cn && near(cn.totals.grandTotal, inv2.totals.grandTotal), "cancel: seller credit note reverses the seller invoice");
  check(pcn && CN16.test(pcn.creditNoteNumber) && pcn.creditNoteNumber.startsWith("MSPF/") && near(pcn.totals.grandTotal, pinv2.totals.grandTotal) && pcn.scope === "full", `cancel: platform credit note ${pcn?.creditNoteNumber} reverses the platform fee`);
  const docs = await call("GET", `/orders/${o2._id}/invoices`, { token: ADMIN });
  check(docs.data[1].creditNotes.length === 1 && docs.data[1].creditNotes[0].pdf.includes("/platform-credit-notes/"), "platform credit note listed with its PDF link");
  const cpdf = await call("GET", docs.data[1].creditNotes[0].pdf.replace("/api/v1", ""), { token: ADMIN, raw: true });
  check(cpdf.status === 200 && cpdf.buffer.subarray(0, 5).toString() === "%PDF-", "platform credit note PDF");
}

// Seller-fault return of every unit: fees refunded -> platform share on a partial platform credit note.
{
  let o = await newOrder(storeMH, buyerMH, 2);
  o = await confirmOrder(o, null);
  for (const step of ["processing", "ready_to_ship", "shipped", "delivered"]) o = await advanceOrder(o, step, {});
  await Order.updateOne({ _id: o._id }, { $set: { "items.$[].easyReturn": true } });
  o = await Order.findById(o._id);
  const buyerReq = { user: { _id: buyerMH.user._id }, permissions: ["orders.view", "orders.cancel", "orders.create"], isBuyer: true, isPlatformAdmin: false };
  o = await orders.requestReturn(buyerReq, String(o._id), { reason: "damaged", refundDestination: { type: "store_credit" } });
  const ret = o.returns[0];
  o = await approveReturn(o, { actorId: null });
  o = await receiveReturn(o, { actorId: null, damaged: {} });
  const pcn = await PlatformCreditNote.findOne({ orderId: o._id });
  const cn = await CreditNote.findOne({ orderId: o._id });
  check(pcn && pcn.scope === "partial" && near(pcn.totals.grandTotal, o.platformFee), `return: platform credit note for the platform fee share (${pcn?.totals.grandTotal})`);
  check(cn && !cn.lines.some((l) => /Platform fee/.test(l.description)) && near(cn.totals.grandTotal + pcn.totals.grandTotal, ret.refundAmount), "return: seller note + platform note = refund amount");
}

// Old (pre-phase-4) combined invoice: stays combined; cancel credits it in full, no platform documents.
{
  let o = await newOrder(storeMH, buyerMH, 1);
  o = await confirmOrder(o, null);
  const inv = await Invoice.findOne({ orderId: o._id });
  const combinedLines = buildInvoiceLines(o, inv.supplyType);
  await PlatformOrderInvoice.deleteOne({ orderId: o._id });
  await Order.updateOne({ _id: o._id }, { $set: { platformInvoiceId: null, platformInvoiceNumber: "" } });
  await Invoice.collection.updateOne({ _id: inv._id }, { $unset: { feeLayout: "" }, $set: { lines: combinedLines, totals: sumTotals(combinedLines) } });
  const before = (await Invoice.findById(inv._id).lean()).totals.grandTotal;
  check(near(before, o.total), "legacy combined invoice carries the platform fee (total = order total)");
  const docs = await call("GET", `/orders/${o._id}/invoices`, { token: ADMIN });
  check(docs.data.length === 1 && docs.data[0].feeLayout === "combined", "GET /invoices on an old order: one combined seller invoice, no platform invoice issued");
  await cancelOrder(o, null, "old order cancel");
  const cn = await CreditNote.findOne({ orderId: o._id });
  check(cn && near(cn.totals.grandTotal, o.total) && cn.lines.some((l) => /Platform fee/.test(l.description)), "legacy cancel: full credit note incl. platform fee");
  check((await PlatformCreditNote.countDocuments({ orderId: o._id })) === 0 && (await PlatformOrderInvoice.countDocuments({ orderId: o._id })) === 0, "legacy order: no platform invoice / credit note");
  check((await Invoice.findById(inv._id).lean()).feeLayout === undefined, "legacy invoice document untouched");
}

/* ------------------------------------------------------------------ 3. GSTR-8 + TDS */
console.log("\n# GSTR-8 / TDS 194-O");
const at = (s) => new Date(s);
const tA = await Tenant.create({ name: "Alpha Store", slug: "alpha-p4t", status: "active", businessProfile: { gstin: gstin("27", "AAPFA1111A"), legalName: "Alpha LLP" } });
const tB = await Tenant.create({ name: "Beta Store", slug: "beta-p4t", status: "active", businessProfile: { gstin: gstin("07", "AAPFA1111A"), legalName: "Alpha LLP" } }); // same PAN, other state
const tC = await Tenant.create({ name: "Gamma Store", slug: "gamma-p4t", status: "active", businessProfile: { gstin: gstin("29", "AAPFG2222G") }, kyc: { pan: "AAPFG2222G" } });
const tFixtureOrder = await Order.findById(o1._id).lean(); // MH -> MH (intra), used for recomputation
let k = 0;
const L = (tenantId, kind, amountPaise, createdAt, extra = {}) => ({
  tenantId,
  key: `p4t:${(k += 1)}`,
  kind,
  amountPaise,
  orderId: null,
  orderNumber: "",
  refundRef: "",
  payoutId: null,
  transferId: "",
  availableAt: createdAt,
  memo: kind,
  data: {},
  createdAt,
  ...extra,
});
await SellerLedgerEntry.collection.insertMany([
  // Alpha (MH): Oct sales 10,000 intra, 4,000 inter; return of 1,000 intra.
  L(tA._id, "tcs", -5000, at("2026-10-05T06:00:00Z"), { data: { base: 1000000, supplyType: "intra", igst: 0, cgst: 2500, sgst: 2500 } }),
  L(tA._id, "tds", -1000, at("2026-10-05T06:00:00Z"), { data: { base: 1000000 } }),
  L(tA._id, "tcs", -2000, at("2026-10-20T06:00:00Z"), { data: { base: 400000, supplyType: "inter", igst: 2000, cgst: 0, sgst: 0 } }),
  L(tA._id, "tds", -400, at("2026-10-20T06:00:00Z"), { data: { base: 400000 } }),
  L(tA._id, "tcs_reversal", 500, at("2026-10-25T06:00:00Z"), { data: { base: 100000, supplyType: "intra", igst: 0, cgst: 250, sgst: 250 } }),
  L(tA._id, "tds_reversal", 100, at("2026-10-25T06:00:00Z"), { data: { base: 100000 } }),
  // Alpha: September and 31 Oct 19:00 UTC (= 1 Nov IST) are outside October.
  L(tA._id, "tcs", -999, at("2026-09-30T18:00:00Z"), { data: { base: 199800, supplyType: "inter", igst: 999, cgst: 0, sgst: 0 } }),
  L(tA._id, "tcs", -777, at("2026-10-31T19:00:00Z"), { data: { base: 155400, supplyType: "inter", igst: 777, cgst: 0, sgst: 0 } }),
  // Beta (DL, same PAN as Alpha): 2,000.
  L(tB._id, "tcs", -1000, at("2026-10-10T06:00:00Z"), { data: { base: 200000, supplyType: "inter", igst: 1000, cgst: 0, sgst: 0 } }),
  L(tB._id, "tds", -200, at("2026-11-10T06:00:00Z"), { data: { base: 200000 } }),
  // Gamma: older row without split data -> split recomputed from the linked order (intra).
  L(tC._id, "tcs", -301, at("2026-10-11T06:00:00Z"), { orderId: tFixtureOrder._id, data: { base: 60200 } }),
  L(tC._id, "tds", -60, at("2026-12-31T06:00:00Z"), { orderId: tFixtureOrder._id, data: {} }),
]);
{
  const r = await reports.gstr8("2026-10");
  const a = r.rows.find((x) => x.tenantId === String(tA._id));
  const b = r.rows.find((x) => x.tenantId === String(tB._id));
  const c = r.rows.find((x) => x.tenantId === String(tC._id));
  check(a && near(a.grossTaxable, 14000) && near(a.returns, 1000) && near(a.netTaxable, 13000), `Alpha gross 14000 / returns 1000 / net 13000 (${a?.grossTaxable}/${a?.returns}/${a?.netTaxable})`);
  check(near(a.tcsIgst, 20) && near(a.tcsCgst, 22.5) && near(a.tcsSgst, 22.5) && near(a.tcsTotal, 65), `Alpha TCS IGST 20, CGST 22.5, SGST 22.5 (${a.tcsIgst}/${a.tcsCgst}/${a.tcsSgst})`);
  check(b && b.gstin.startsWith("07") && near(b.tcsIgst, 10), "Beta reported under its own GSTIN");
  check(c && near(c.tcsCgst + c.tcsSgst, 3.01) && c.tcsIgst === 0, `Gamma: split recomputed from the order (intra) ${c?.tcsCgst}+${c?.tcsSgst}`);
  check(r.month === "2026-10" && near(r.totals.tcsTotal, r.rows.reduce((s2, x) => s2 + x.tcsTotal, 0)) && near(a.tcsTotal + b.tcsTotal + c.tcsTotal, 65 + 10 + 3.01), `month totals ${r.totals.tcsTotal}`);
  const res = await call("GET", "/admin/tax/gstr8?month=2026-10&format=csv", { token: ADMIN });
  const lines = String(res.data).trim().split(/\r\n/);
  check(res.status === 200 && /text\/csv/.test(res.headers.get("content-type")) && lines[0].startsWith("Month,GSTIN") && lines.some((l) => l.includes(gstin("27", "AAPFA1111A")) && l.includes("13000.00")), "GSTR-8 CSV");
  const json = await call("GET", "/admin/tax/gstr8?month=2026-10", { token: ADMIN });
  check(json.status === 200 && json.data.rows.length >= 3, "GSTR-8 JSON over HTTP");
  const bad = await call("GET", "/admin/tax/gstr8?month=2026-13", { token: ADMIN });
  check(bad.status === 400, "invalid month -> 400");
  const sellerAdmin = await User.create({ name: "Alpha admin", email: "alpha@p4t.test", passwordHash: "x", roleId: roles.tenant_admin._id, tenantId: tA._id, status: "active", emailVerified: true });
  const sellerTok = await tokenFor(sellerAdmin);
  const forbidden = await call("GET", "/admin/tax/gstr8?month=2026-10", { token: sellerTok });
  check(forbidden.status === 403, "sellers cannot read GSTR-8");
  const ownStmt = await call("GET", "/payouts/me/statements/2026-10?format=json", { token: sellerTok });
  check(ownStmt.status === 200 && ownStmt.data.store.gstin === gstin("27", "AAPFA1111A"), `store admin (payouts.view) reads its own statement (${ownStmt.status})`);
  const cross = await call("GET", "/payouts/me/statements/2026-10", { token: sellerTok, headers: { "X-Tenant-Id": String(tB._id) } });
  check(cross.status === 403, "cannot read another store's statement");
  const adminStmt = await call("GET", `/admin/payouts/sellers/${tA._id}/statements/2026-10`, { token: sellerTok });
  check(adminStmt.status === 403, "admin statement route needs payouts.manage");
}
{
  const r = await reports.tdsReport("2026-Q3");
  const alpha = r.rows.find((x) => x.pan === "AAPFA1111A");
  const gamma = r.rows.find((x) => x.pan === "AAPFG2222G");
  check(alpha && alpha.stores.length === 2 && near(alpha.grossSales, 16000) && near(alpha.returns, 1000) && near(alpha.tds, 15), `PAN AAPFA1111A (2 stores): gross 16000, returns 1000, TDS 15 (${alpha?.grossSales}/${alpha?.tds})`);
  check(gamma && near(gamma.tds, 0.6) && gamma.grossSales > 0, `Gamma TDS 0.60 with base recomputed from the order (${gamma?.grossSales})`);
  const res = await call("GET", "/admin/tax/tds?quarter=2026-Q3&format=csv", { token: ADMIN });
  check(res.status === 200 && String(res.data).startsWith("Quarter,PAN") && String(res.data).includes("AAPFA1111A"), "TDS CSV");
  const q4 = await reports.tdsReport("2026-Q4");
  check(!q4.rows.some((x) => x.pan === "AAPFA1111A"), "Q4 (Jan-Mar 2027) excludes Q3 rows");
}

/* ------------------------------------------------------------------ 4. statements */
console.log("\n# seller statements");
{
  const tS = await Tenant.create({ name: "Stmt Store", slug: "stmt-p4t", status: "active", businessProfile: { gstin: gstin("27", "AAPFS3333S") } });
  await SellerLedgerEntry.collection.insertMany([
    L(tS._id, "sale", 1000000, at("2026-09-15T06:00:00Z"), { orderNumber: "ORD-1" }),
    L(tS._id, "payout", -400000, at("2026-09-28T06:00:00Z")),
    L(tS._id, "platform_fee", -10000, at("2026-10-01T06:00:00Z"), { orderNumber: "ORD-2" }),
    L(tS._id, "sale", 500000, at("2026-10-02T06:00:00Z"), { orderNumber: "ORD-2", availableAt: null }),
    L(tS._id, "tcs", -2500, at("2026-10-02T06:00:00Z"), { orderNumber: "ORD-2", availableAt: null, data: { base: 500000, supplyType: "inter", igst: 2500, cgst: 0, sgst: 0 } }),
    L(tS._id, "tds", -500, at("2026-10-02T06:00:00Z"), { orderNumber: "ORD-2", availableAt: null, data: { base: 500000 } }),
    L(tS._id, "tcs_reversal", 500, at("2026-10-09T06:00:00Z"), { orderNumber: "ORD-2", data: { base: 100000, supplyType: "inter", igst: 500, cgst: 0, sgst: 0 } }),
    L(tS._id, "payout", -500000, at("2026-10-30T06:00:00Z")),
    L(tS._id, "adjustment", 7000, at("2026-11-02T06:00:00Z")),
  ]);
  const st = await reports.sellerStatement(tS._id, "2026-10");
  check(near(st.openingBalance, 6000), `opening balance = Sept net (${st.openingBalance})`);
  check(st.lines.length === 6 && near(st.closingBalance, 6000 - 100 + 5000 - 25 - 5 + 5 - 5000), `6 October lines, closing ${st.closingBalance}`);
  check(near(st.lines[st.lines.length - 1].balance, st.closingBalance) && st.lines[1].orderNumber === "ORD-2" && st.lines[1].held === true, "running balance + held flag + order number");
  check(near(st.totals.tcs, 20) && near(st.totals.tds, 5) && near(st.totals.heldAtClose, 5000 - 25 - 5), `TCS 20 (25 - 5 reversed), TDS 5, held at close (${st.totals.tcs}/${st.totals.tds}/${st.totals.heldAtClose})`);
  const nov = await reports.sellerStatement(tS._id, "2026-11");
  check(near(nov.openingBalance, st.closingBalance) && near(nov.closingBalance, st.closingBalance + 70), "next month opens at the previous close");
  const csv = await call("GET", `/admin/payouts/sellers/${tS._id}/statements/2026-10?format=csv`, { token: ADMIN });
  check(csv.status === 200 && String(csv.data).includes("Opening balance") && String(csv.data).includes("Closing balance") && String(csv.data).includes("ORD-2"), "admin statement CSV");
  const pdf = await call("GET", `/admin/payouts/sellers/${tS._id}/statements/2026-10?format=pdf`, { token: ADMIN, raw: true });
  check(pdf.status === 200 && pdf.buffer.subarray(0, 5).toString() === "%PDF-", "statement PDF");
  const me = await call("GET", "/payouts/me/statements/2026-10", { token: ADMIN, headers: { "X-Tenant-Id": String(tS._id) } });
  check(me.status === 200 && near(me.data.closingBalance, st.closingBalance), "seller statement route (platform admin acting in the store)");
  const sum = await call("GET", "/payouts/me/tax?fy=2026-27", { token: ADMIN, headers: { "X-Tenant-Id": String(tS._id) } });
  const oct = sum.data?.tcs?.months?.find((m) => m.month === "2026-10");
  check(sum.status === 200 && sum.data.tcs.months.length === 12 && near(oct.tcs, 20) && near(oct.taxable, 4000) && near(sum.data.tds.quarters[2].tds, 5), "seller tax summary: TCS by month, TDS by quarter");
  const cashier = await User.create({ name: "No perms", email: "np@p4t.test", passwordHash: "x", roleId: roles.buyer._id, status: "active", emailVerified: true });
  const deny = await call("GET", "/payouts/me/statements/2026-10", { token: await tokenFor(cashier) });
  check(deny.status === 403, `buyers cannot read seller statements (${deny.status})`);
}

/* ------------------------------------------------------------------ 5. reconciliation */
console.log("\n# reconciliation (faked Razorpay)");
{
  const D = "2026-10-05";
  const ordA = await newOrder(storeMH, buyerMH, 1);
  const ordB = await newOrder(storeMH, buyerMH, 1);
  const ordM = await newOrder(storeMH, buyerMH, 1);
  const ordR = await newOrder(storeMH, buyerMH, 1);
  const paise = (n) => Math.round(n * 100);
  await Order.collection.updateOne({ _id: ordA._id }, { $set: { razorpayPaymentId: "pay_A", razorpayAmountPaise: paise(ordA.total), paidAt: at("2026-10-03T05:00:00Z") } });
  await Order.collection.updateOne({ _id: ordB._id }, { $set: { razorpayPaymentId: "pay_B", razorpayAmountPaise: paise(ordB.total), paidAt: at("2026-10-03T06:00:00Z") } });
  await Order.collection.updateOne({ _id: ordM._id }, { $set: { razorpayPaymentId: "pay_M", razorpayAmountPaise: paise(ordM.total), paidAt: at("2026-10-03T07:00:00Z") } });
  await Order.collection.updateOne(
    { _id: ordR._id },
    { $set: { razorpayPaymentId: "pay_R", refunds: [{ _id: new mongoose.Types.ObjectId(), key: "r1", amount: 50, status: "processed", providerRefundId: "rfnd_1", processedAt: at("2026-10-04T05:00:00Z"), method: "razorpay", provider: "razorpay" }] } }
  );
  await SellerLedgerEntry.collection.insertMany([
    L(storeMH.tenant._id, "sale", 9000, at("2026-10-03T05:00:00Z"), { transferId: "trf_1" }),
    L(storeMH.tenant._id, "tcs", -45, at("2026-10-03T05:00:00Z"), { transferId: "trf_1", data: { base: 9000, supplyType: "intra", igst: 0, cgst: 23, sgst: 22 } }),
  ]);
  const rows = {
    [D]: [
      { entity_id: "pay_A", type: "payment", amount: paise(ordA.total), fee: 236, tax: 36, credit: paise(ordA.total) - 236, debit: 0, settlement_id: "setl_1" },
      { entity_id: "pay_B", type: "payment", amount: paise(ordB.total) - 100, fee: 200, tax: 30, credit: paise(ordB.total) - 300, debit: 0, settlement_id: "setl_1" },
      { entity_id: "pay_X", type: "payment", amount: 5000, fee: 100, tax: 15, credit: 4900, debit: 0, settlement_id: "setl_1" },
      { entity_id: "rfnd_1", type: "refund", amount: 5000, fee: 0, tax: 0, credit: 0, debit: 5000, settlement_id: "setl_1" },
      { entity_id: "trf_1", type: "transfer", amount: 8955, fee: 0, tax: 0, credit: 0, debit: 8955, settlement_id: "setl_2" },
      { entity_id: "adj_9", type: "adjustment", amount: 10, credit: 10, debit: 0, settlement_id: "setl_2" },
    ],
    "2026-10-06": [{ entity_id: "pay_M", type: "payment", amount: paise(ordM.total), fee: 100, tax: 15, credit: paise(ordM.total) - 100, debit: 0, settlement_id: "setl_3" }],
  };
  const setl1 = rows[D].filter((r) => r.settlement_id === "setl_1").reduce((s, r) => s + r.credit - r.debit, 0);
  setRazorpayClient({
    fetchSettlementRecon: async ({ year, month, day }) => ({ items: rows[`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`] || [] }),
    listSettlements: async ({ from }) => {
      const d = new Date(from * 1000 + 330 * 60 * 1000).toISOString().slice(0, 10);
      if (d === D) return { items: [{ id: "setl_1", amount: setl1, fees: 536, tax: 81, utr: "UTR1" }, { id: "setl_2", amount: -1, utr: "UTR2" }] };
      return { items: [] };
    },
  });
  const run = await recon.runReconciliation(D, { source: "test" });
  const item = (id) => run.items.find((i) => i.entityId === id);
  check(item("pay_A").status === "matched" && item("pay_A").feePaise === 236 && item("pay_A").ourRef === ordA.orderNumber, "payment matched to its order (fee recorded)");
  check(item("pay_B").status === "mismatched" && item("pay_B").problem === "amount_mismatch" && item("pay_B").expectedPaise - item("pay_B").actualPaise === 100, "payment amount mismatch flagged");
  check(item("pay_X").status === "unknown" && item("pay_X").problem === "not_found", "unknown Razorpay payment flagged");
  check(item("rfnd_1").status === "matched" && item("rfnd_1").expectedPaise === 5000, "refund matched to the order refund (Rs 50 = 5000 paise)");
  check(item("trf_1").status === "matched" && item("trf_1").expectedPaise === 8955, "transfer matched to seller ledger lines (net of TCS)");
  check(item("adj_9").status === "unknown" && item("adj_9").type === "settlement", "unrecognised row type -> unknown settlement item");
  check(item("setl_1").status === "matched" && item("setl_2").status === "mismatched" && item("setl_2").problem === "settlement_total_mismatch", "settlement totals checked against their rows");
  check(item("pay_M").status === "missing" && item("pay_M").problem === "not_in_settlement", "our T-2 payment absent from the recon -> missing");
  check(run.counts.matched === 4 && run.counts.mismatched === 2 && run.counts.missing === 1 && run.counts.unknown === 2 && run.counts.unresolved === 5, `counts ${JSON.stringify(run.counts)}`);

  const resolved = await call("POST", `/admin/reconciliation/runs/${run._id}/items/${item("pay_X")._id}/resolve`, { token: ADMIN, json: { note: "Test payment from dashboard" } });
  check(resolved.status === 200 && resolved.data.counts.unresolved === 4, "admin resolves an item");
  const again = await call("POST", "/admin/reconciliation/runs", { token: ADMIN, json: { date: D } });
  check(again.status === 201 && again.data.items.find((i) => i.entityId === "pay_X").resolved.note === "Test payment from dashboard", "re-running the day keeps manual resolutions");
  const next = await recon.runReconciliation("2026-10-06", { source: "test" });
  check(next.items.find((i) => i.entityId === "pay_M").status === "matched", "late settlement matched next day");
  const old = await ReconciliationRun.findOne({ date: D }).lean();
  check(old.items.find((i) => i.entityId === "pay_M").resolved.at && old.counts.unresolved === 3, "earlier missing item auto-resolved");
  const list = await call("GET", "/admin/reconciliation/runs", { token: ADMIN });
  check(list.status === 200 && list.data.data.length === 2 && list.data.data[0].date === "2026-10-06" && !list.data.data[0].items, "runs list (newest first, no items)");
  const one = await call("GET", `/admin/reconciliation/runs/${run._id}?problems=true`, { token: ADMIN });
  check(one.status === 200 && one.data.items.every((i) => i.status !== "matched"), "run detail filtered to problems");
  const job = await runJob("payout-reconcile");
  check(job.ran === true && job.result.date, `job payout-reconcile runs (${job.result?.date})`);
}

/* ------------------------------------------------------------------ 6. COD remittances */
console.log("\n# COD remittances");
{
  const mk = async (by = "courier") => {
    const o = await newOrder(storeMH, buyerMH, 1);
    await Order.collection.updateOne(
      { _id: o._id },
      { $set: { status: "delivered", deliveredAt: at("2026-10-01T06:00:00Z"), codCollection: { by, carrier: "delhivery", amount: o.total, at: at("2026-10-01T06:00:00Z"), remittedAt: null, remittanceReference: "" }, fulfillments: [{ _id: new mongoose.Types.ObjectId(), kind: "forward", carrier: "delhivery", trackingNumber: `AWB${o.orderNumber}` }] } }
    );
    return Order.findById(o._id).lean();
  };
  const ok = await mk();
  const short = await mk();
  const excess = await mk();
  const seller = await mk("seller");
  const pending = await mk();
  const res = await call("POST", "/admin/cod-remittances", {
    token: ADMIN,
    json: {
      carrier: "delhivery",
      reference: "DLV-REM-1",
      receivedAt: "2026-10-08",
      rows: [
        { orderNumber: ok.orderNumber, amount: ok.total },
        { awb: `AWB${short.orderNumber}`, amount: short.total - 20 },
        { orderNumber: excess.orderNumber, amount: excess.total + 5 },
        { orderNumber: seller.orderNumber, amount: seller.total },
        { orderNumber: "NOPE-1", amount: 10 },
      ],
    },
  });
  const st = (n) => res.data.rows.find((r) => r.orderNumber === n)?.status;
  check(res.status === 201 && st(ok.orderNumber) === "ok" && st(short.orderNumber) === "short" && st(excess.orderNumber) === "excess", `rows ok / short / excess (${res.status})`);
  check(st(seller.orderNumber) === "not_courier_cod" && st("NOPE-1") === "not_found", "seller-collected COD and unknown orders flagged");
  check(near(res.data.totals.short, 20) && near(res.data.totals.excess, 5) && res.data.totals.matchedOrders === 3 && res.data.totals.flagged === 4, `totals ${JSON.stringify(res.data.totals)}`);
  const okDb = await Order.findById(ok._id).lean();
  check(okDb.codCollection.remittedAt && okDb.codCollection.remittanceReference === "DLV-REM-1", "order marked remitted with the reference");
  const dup = await call("POST", "/admin/cod-remittances", { token: ADMIN, json: { carrier: "delhivery", reference: "DLV-REM-1", rows: [{ orderNumber: pending.orderNumber, amount: 1 }] } });
  check(dup.status === 409, "same remittance reference twice -> 409");
  const again = await call("POST", "/admin/cod-remittances", { token: ADMIN, json: { carrier: "delhivery", reference: "DLV-REM-2", rows: [{ orderNumber: ok.orderNumber, amount: ok.total }] } });
  check(again.data.rows[0].status === "already_remitted", "already remitted order flagged");
  const un = await call("GET", "/admin/cod-remittances/unremitted?carrier=delhivery", { token: ADMIN });
  const nums = un.data.data.map((r) => r.orderNumber);
  check(un.status === 200 && nums.includes(pending.orderNumber) && !nums.includes(ok.orderNumber) && !nums.includes(seller.orderNumber), "unremitted list: pending courier COD only");
  const row = un.data.data.find((r) => r.orderNumber === pending.orderNumber);
  check(row.ageDays >= 1 && row.awb === `AWB${pending.orderNumber}` && un.data.meta.amount > 0, `age ${row.ageDays} days, AWB, total amount`);
  const list = await call("GET", "/admin/cod-remittances", { token: ADMIN });
  check(list.status === 200 && list.data.data.length === 2, "remittance list");
}

void fakeRzp;
server.close();
await teardown();
finish("phase4Tax");
