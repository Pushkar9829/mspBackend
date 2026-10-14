/**
 * Phase 3 (p3-billing): plans CRUD + public list, legacy migration, approval -> awaiting payment
 * (store paused) -> first invoice paid online (order + signature) -> active, GST invoice numbering /
 * tax split / PDF, upgrade (pro-rated) / downgrade at renewal, renewal job + dunning (past_due,
 * reminders 0/3/6, pause after grace, resume on payment), extend grace, comp, discount + credits,
 * void, autopay (Razorpay plan + subscription, webhooks charged / halted, idempotent), invoice
 * paid by webhook, legacy ending reminder + early plan purchase.
 *
 * Throwaway local replica set only (the database is dropped); Razorpay is faked:
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_p3b?replicaSet=rs0" node src/tests/phase3Billing.js
 */
import assert from "assert/strict";
import express from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { requestId } from "../middleware/requestId.js";
import { notFound, errorHandler } from "../middleware/error.js";
import { signAccessToken } from "../utils/tokens.js";
import { bus } from "../utils/events.js";
import { ensureSystemRoles } from "../seeds/index.js";
import v1 from "../routes/v1.js";
import { User } from "../modules/users/user.model.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { Settings } from "../modules/settings/settings.model.js";
import { invalidateSettingCache } from "../modules/settings/service.js";
import { createTenantFromApplication } from "../modules/tenants/service.js";
import { setRazorpayClient, hmac } from "../modules/checkout/razorpayApi.js";
import { processRazorpayEvent } from "../modules/checkout/razorpay.js";
import { Plan } from "../modules/billing/plan.model.js";
import { TenantSubscription } from "../modules/billing/subscription.model.js";
import { SubscriptionInvoice } from "../modules/billing/invoice.model.js";
import { runBillingMigrations } from "../modules/billing/migrate.js";
import { runBillingRenewals, BILLING_PAUSE_REASONS, addInterval } from "../modules/billing/service.js";
import { setupAutopay } from "../modules/billing/razorpayBilling.js";
import { gstinCheckChar } from "../utils/gstin.js";
import { JOBS } from "../jobs/index.js";
import { withTransaction } from "../utils/transaction.js";

if (!/127\.0\.0\.1:27027\/msp_test_p3b(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_p3b database");
  process.exit(2);
}

await mongoose.connect(env.mongoUri);
await mongoose.connection.db.dropDatabase();
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes().catch(() => {})));

/* ---------------------------------------------------------------- fake Razorpay */
let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq += 1)}`;
const fake = { orders: [], plans: [], subs: [], links: [], payments: new Map(), updates: [], cancels: [], subStatus: new Map() };
setRazorpayClient({
  createOrder: async ({ amount, receipt, notes }) => {
    const row = { id: `order_${uid()}`, amount, receipt, notes };
    fake.orders.push(row);
    return row;
  },
  fetchPayment: async (id) => fake.payments.get(id) || { id, status: "captured", currency: "INR" },
  capturePayment: async (id, amount) => ({ ...(fake.payments.get(id) || { id, amount }), status: "captured" }),
  createPlan: async (body) => {
    const row = { id: `plan_${uid()}`, ...body };
    fake.plans.push(row);
    return row;
  },
  createSubscription: async (body) => {
    const row = { id: `sub_${uid()}`, status: "created", short_url: "https://rzp.io/i/test", ...body };
    fake.subs.push(row);
    return row;
  },
  updateSubscription: async (id, body) => {
    fake.updates.push({ id, ...body });
    return { id, ...body };
  },
  cancelSubscription: async (id) => {
    fake.cancels.push(id);
    return { id, status: "cancelled" };
  },
  fetchSubscription: async (id) => ({ id, status: fake.subStatus.get(id) || "created" }),
  createPaymentLink: async (body) => {
    const row = { id: `plink_${uid()}`, short_url: "https://rzp.io/l/test", ...body };
    fake.links.push(row);
    return row;
  },
});
env.razorpayKeyId = "rzp_test_billing";
env.razorpayKeySecret = "billing_test_secret";

/* ---------------------------------------------------------------- app */
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
  return { status: res.status, data };
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n     ${err.stack}`);
    process.exitCode = 1;
  }
}

const events = [];
for (const e of [
  "SUBSCRIPTION_INVOICE_ISSUED",
  "SUBSCRIPTION_PAYMENT_RECEIVED",
  "SUBSCRIPTION_PAYMENT_FAILED",
  "SUBSCRIPTION_PAST_DUE",
  "SUBSCRIPTION_PAUSED",
  "SUBSCRIPTION_RESUMED",
  "SUBSCRIPTION_PLAN_CHANGED",
  "SUBSCRIPTION_LEGACY_ENDING",
  "TENANT_PAUSED",
  "TENANT_RESUMED",
]) {
  bus.on(e, (p) => events.push({ e, p }));
}
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const eventsOf = (e, tenantId) => events.filter((x) => x.e === e && (!tenantId || String(x.p.tenantId) === String(tenantId)));
const DAY = 86400000;
const r2 = (n) => Math.round(n * 100) / 100;

function gstin(stateCode, pan = "AAPFU0939F") {
  const first14 = `${stateCode}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
}

/* ---------------------------------------------------------------- fixtures */
const roles = await ensureSystemRoles();
const PLATFORM_GSTIN = gstin("27", "AAACM1234A");
await Settings.insertMany([
  { scope: "platform", tenantId: null, key: "platform.legalName", value: "MSP Marketplace Pvt Ltd" },
  { scope: "platform", tenantId: null, key: "platform.gstin", value: PLATFORM_GSTIN },
  { scope: "platform", tenantId: null, key: "platform.address", value: "1 Market Road, Mumbai" },
  { scope: "platform", tenantId: null, key: "platform.state", value: "Maharashtra" },
  { scope: "platform", tenantId: null, key: "platform.invoicePrefix", value: "MSPB" },
]);
invalidateSettingCache();

async function mkUser(name, email, role, { tenantId = null } = {}) {
  return User.create({ name, email, passwordHash: "x", roleId: role._id, tenantId, status: "active", emailVerified: true });
}
const tokenFor = async (user) => {
  const fresh = await User.findById(user._id).lean();
  return signAccessToken({ sub: String(fresh._id), tenantId: fresh.tenantId ? String(fresh.tenantId) : null, tv: fresh.tokenVersion || 0 });
};
const platform = await mkUser("Platform", "pa@p3b.test", roles.super_admin);
const T = { platform: await tokenFor(platform) };

// Existing store (before billing): gets the legacy plan by migration.
const OLD = await Tenant.create({ name: "Old Store", slug: "old-store", status: "active", businessProfile: { gstin: gstin("29") } });
const oldAdmin = await mkUser("Old Admin", "old@p3b.test", roles.tenant_admin, { tenantId: OLD._id });
T.old = await tokenFor(oldAdmin);

let basic;
let pro;
let yearlyOnly;

async function approveNew(tag, { planId = null, state = "27" } = {}) {
  const applicant = await User.create({ name: `Seller ${tag}`, email: `${tag}@p3b.test`, passwordHash: "x", roleId: roles.buyer._id, status: "active", emailVerified: true });
  const application = {
    _id: new mongoose.Types.ObjectId(),
    userId: applicant._id,
    email: `${tag}@p3b.test`,
    phone: "9876543210",
    business: { legalName: `${tag} Traders LLP`, tradeName: `${tag} Traders`, businessType: "llp", gstin: gstin(state, `AAB${tag.toUpperCase().padEnd(2, "X").slice(0, 2)}1234A`), pan: "AABCA1234A" },
    registeredAddress: { addressLine1: "2 Main St", city: "Pune", state: state === "27" ? "Maharashtra" : "Karnataka", postalCode: "411001" },
    pickupAddress: { addressLine1: "2 Main St", city: "Pune", state: state === "27" ? "Maharashtra" : "Karnataka", postalCode: "411001" },
    bank: { holderName: "X", accountLast4: "1234", ifsc: "HDFC0001234" },
    documents: [],
    planId,
  };
  // Same transaction as the real approval (seller-applications approve).
  const tenant = await withTransaction((session) => createTenantFromApplication(application, { by: platform._id, session }));
  await tick();
  return { tenant, user: applicant, token: await tokenFor(applicant) };
}

const subOf = (tenantId) => TenantSubscription.findOne({ tenantId }).lean();
const openInvoices = (tenantId) => SubscriptionInvoice.find({ tenantId, status: "issued" }).sort({ createdAt: 1 }).lean();

async function payOnline(token, invoiceId, { tamper = false } = {}) {
  const order = await call("POST", `/billing/me/invoices/${invoiceId}/pay`, { token, json: {} });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  const paymentId = `pay_${uid()}`;
  fake.payments.set(paymentId, { id: paymentId, order_id: order.data.orderId, status: "captured", amount: order.data.amount, currency: "INR" });
  const signature = hmac(env.razorpayKeySecret, `${order.data.orderId}|${paymentId}`);
  return call("POST", `/billing/me/invoices/${invoiceId}/verify`, {
    token,
    json: { razorpayOrderId: order.data.orderId, razorpayPaymentId: paymentId, razorpaySignature: tamper ? signature.slice(0, -1) + (signature.endsWith("0") ? "1" : "0") : signature },
  });
}

/* ---------------------------------------------------------------- tests */

await check("migration: legacy plan + legacy subscription for existing stores; idempotent; legacyUntil persisted", async () => {
  const first = await runBillingMigrations();
  assert.equal(first.legacyAssigned, 1);
  const legacy = await Plan.findOne({ code: "legacy" }).lean();
  assert.equal(legacy.priceInr, 0);
  assert.equal(legacy.isPublic, false);
  assert.equal(legacy.limits.products, -1);
  const sub = await subOf(OLD._id);
  assert.equal(sub.status, "legacy");
  assert.ok(sub.legacyUntil > new Date(Date.now() + 89 * DAY));
  const setting = await Settings.findOne({ key: "billing.legacyUntil" }).lean();
  assert.equal(new Date(setting.value).getTime(), sub.legacyUntil.getTime());
  assert.equal((await runBillingMigrations()).legacyAssigned, 0);
});

await check("admin plans: CRUD, permissions, validation; public /plans lists active public plans only", async () => {
  const denied = await call("GET", "/admin/plans", { token: T.old });
  assert.equal(denied.status, 403);
  const c1 = await call("POST", "/admin/plans", {
    token: T.platform,
    json: { code: "basic", name: "Basic", priceInr: 499, limits: { products: 100, staff: 2 }, features: { coupons: true }, sortOrder: 1 },
  });
  assert.equal(c1.status, 201, JSON.stringify(c1.data));
  basic = c1.data;
  assert.equal(basic.prices.yearly, 5988);
  assert.equal(basic.pricesWithGst.monthly, 588.82);
  assert.equal(basic.limits.priceLists, -1);
  const c2 = await call("POST", "/admin/plans", { token: T.platform, json: { code: "pro", name: "Pro", priceInr: 999, intervalPrices: { yearly: 9990 }, features: { coupons: true, reports: true }, sortOrder: 2 } });
  assert.equal(c2.status, 201);
  pro = c2.data;
  assert.equal(pro.prices.yearly, 9990);
  const c3 = await call("POST", "/admin/plans", { token: T.platform, json: { code: "hidden", name: "Hidden", priceInr: 50, isPublic: false } });
  assert.equal(c3.status, 201);
  yearlyOnly = c3.data;
  assert.equal((await call("POST", "/admin/plans", { token: T.platform, json: { code: "basic", name: "Dup", priceInr: 1 } })).status, 409);
  assert.equal((await call("POST", "/admin/plans", { token: T.platform, json: { code: "legacy", name: "Legacy two", priceInr: 0 } })).status, 409);
  assert.equal((await call("POST", "/admin/plans", { token: T.platform, json: { code: "x", name: "Bad", priceInr: -1 } })).status, 400);
  const legacy = await Plan.findOne({ code: "legacy" }).lean();
  assert.equal((await call("PATCH", `/admin/plans/${legacy._id}`, { token: T.platform, json: { priceInr: 10 } })).status, 409);
  assert.equal((await call("POST", `/admin/plans/${legacy._id}/archive`, { token: T.platform })).status, 409);
  const pub = await call("GET", "/plans");
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.data.data.map((p) => p.code), ["basic", "pro"]);
  const arch = await call("POST", `/admin/plans/${yearlyOnly.id}/archive`, { token: T.platform });
  assert.equal(arch.data.status, "archived");
  const all = await call("GET", "/admin/plans", { token: T.platform });
  assert.equal(all.data.data.length, 4);
});

await check("seller application: optional planId (public active plans only), cleared with null", async () => {
  const { SellerApplication } = await import("../modules/sellerApplications/sellerApplication.model.js");
  const applicant = await mkUser("Applicant", "app@p3b.test", roles.seller_applicant);
  await SellerApplication.create({ userId: applicant._id, email: "app@p3b.test", status: "draft" });
  const tok = await tokenFor(applicant);
  const ok = await call("PATCH", "/seller-applications/me", { token: tok, json: { planId: pro.id, planInterval: "yearly" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(String(ok.data.planId), String(pro.id));
  assert.equal(ok.data.planInterval, "yearly");
  const bad = await call("PATCH", "/seller-applications/me", { token: tok, json: { planId: yearlyOnly.id } });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.fields.planId);
  const cleared = await call("PATCH", "/seller-applications/me", { token: tok, json: { planId: null } });
  assert.equal(cleared.data.planId, null);
});

let S1; // approved store (intra-state)
let firstInvoice;

await check("approval: subscription awaiting_payment, first GST invoice (CGST+SGST), store paused until paid", async () => {
  S1 = await approveNew("one", { planId: basic.id });
  assert.equal(S1.tenant.status, "paused");
  assert.equal(S1.tenant.statusReason, BILLING_PAUSE_REASONS.awaiting);
  const sub = await subOf(S1.tenant._id);
  assert.equal(sub.status, "awaiting_payment");
  assert.equal(sub.planSnapshot.code, "basic");
  const [inv] = await openInvoices(S1.tenant._id);
  firstInvoice = inv;
  assert.equal(inv.kind, "first");
  assert.match(inv.number, /^MSPB\/\d{4}\/000001$/);
  assert.ok(inv.number.length <= 16);
  assert.equal(inv.subtotal, 499);
  assert.equal(inv.supplyType, "intra");
  assert.equal(inv.tax.cgst, 44.91);
  assert.equal(inv.tax.sgst, 44.91);
  assert.equal(inv.tax.igst, 0);
  assert.equal(inv.total, 588.82);
  assert.equal(inv.lines[0].sac, "998314");
  assert.equal(inv.supplier.gstin, PLATFORM_GSTIN);
  await tick();
  assert.equal(eventsOf("SUBSCRIPTION_INVOICE_ISSUED", S1.tenant._id).length, 1);
});

await check("paused store: /billing allowed; GET /billing/me shows outstanding; PDF downloadable (seller + admin)", async () => {
  const me = await call("GET", "/billing/me", { token: S1.token });
  assert.equal(me.status, 200, JSON.stringify(me.data));
  assert.equal(me.data.subscription.status, "awaiting_payment");
  assert.equal(me.data.outstanding.amount, 588.82);
  assert.equal(me.data.outstanding.count, 1);
  const list = await call("GET", "/billing/me/invoices", { token: S1.token });
  assert.equal(list.data.data.length, 1);
  const pdf = await call("GET", `/billing/me/invoices/${firstInvoice._id}/pdf`, { token: S1.token, raw: true });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal(pdf.buffer.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.buffer.toString("latin1").includes(firstInvoice.number.replace(/\//g, "/")));
  const adminPdf = await call("GET", `/admin/subscriptions/invoices/${firstInvoice._id}/pdf`, { token: T.platform, raw: true });
  assert.equal(adminPdf.status, 200);
  // Other store cannot read it.
  assert.equal((await call("GET", `/billing/me/invoices/${firstInvoice._id}`, { token: T.old })).status, 404);
  // Paused store is still blocked elsewhere.
  assert.equal((await call("GET", "/products", { token: S1.token })).status, 403);
});

await check("first invoice paid online: bad signature rejected; verify -> invoice paid, subscription active, store live", async () => {
  const bad = await payOnline(S1.token, firstInvoice._id, { tamper: true });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "PAYMENT_SIGNATURE");
  const ok = await payOnline(S1.token, firstInvoice._id);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, "paid");
  assert.equal(ok.data.payment.method, "razorpay");
  const sub = await subOf(S1.tenant._id);
  assert.equal(sub.status, "active");
  assert.ok(sub.currentPeriodStart <= new Date());
  assert.equal(sub.currentPeriodEnd.getTime(), addInterval(sub.currentPeriodStart, "monthly").getTime());
  const tenant = await Tenant.findById(S1.tenant._id).lean();
  assert.equal(tenant.status, "active");
  await tick();
  assert.equal(eventsOf("SUBSCRIPTION_PAYMENT_RECEIVED", S1.tenant._id).length, 1);
  assert.equal(eventsOf("TENANT_RESUMED", S1.tenant._id).length, 1);
  // Paying again is idempotent / rejected.
  assert.equal((await call("POST", `/billing/me/invoices/${firstInvoice._id}/pay`, { token: S1.token, json: {} })).status, 409);
});

await check("upgrade now: pro-rated invoice; plan switches when paid (admin mark-paid); entitlements follow", async () => {
  const up = await call("POST", "/billing/me/plan", { token: S1.token, json: { planId: pro.id } });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.effective, "on_payment");
  assert.equal(up.data.invoice.kind, "upgrade");
  assert.ok(up.data.invoice.subtotal > 495 && up.data.invoice.subtotal <= 500, `pro-rated ${up.data.invoice.subtotal}`);
  assert.equal((await subOf(S1.tenant._id)).planSnapshot.code, "basic");
  const paid = await call("POST", `/admin/subscriptions/invoices/${up.data.invoice.id}/mark-paid`, { token: T.platform, json: { reference: "UTR12345", mode: "bank_transfer" } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.payment.reference, "UTR12345");
  const sub = await subOf(S1.tenant._id);
  assert.equal(sub.planSnapshot.code, "pro");
  assert.equal(sub.planSnapshot.priceInr, 999);
  try {
    const { getEntitlements } = await import("../modules/billing/entitlements.js");
    const ent = await getEntitlements(S1.tenant._id);
    assert.equal(ent.plan.code, "pro");
    assert.equal(ent.features.reports, true);
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") throw err;
  }
  await tick();
  assert.equal(eventsOf("SUBSCRIPTION_PLAN_CHANGED", S1.tenant._id).at(-1).p.effective, "now");
  // Same plan again -> 409.
  assert.equal((await call("POST", "/billing/me/plan", { token: S1.token, json: { planId: pro.id } })).status, 409);
});

await check("downgrade: scheduled for renewal (pendingPlanId); renewal invoice uses the new plan", async () => {
  const down = await call("POST", "/billing/me/plan", { token: S1.token, json: { planId: basic.id } });
  assert.equal(down.status, 200);
  assert.equal(down.data.effective, "renewal");
  assert.equal(down.data.subscription.pendingPlan.code, "basic");
  const sub = await subOf(S1.tenant._id);
  assert.equal(sub.planSnapshot.code, "pro");
  assert.equal(String(sub.pendingPlanId), String(basic.id));
});

await check("renewal + dunning: invoice before period end, past_due (day 0), reminders 3/6, pause after grace, resume on payment", async () => {
  // Move the paid period into the past so the job's simulated clock stays behind real time.
  const end = new Date(Date.now() - 9 * DAY);
  await TenantSubscription.updateOne({ tenantId: S1.tenant._id }, { $set: { currentPeriodStart: new Date(end.getTime() - 30 * DAY), currentPeriodEnd: end } });
  const r0 = await runBillingRenewals({ now: new Date(end.getTime() - 2 * DAY) });
  assert.equal(r0.invoices, 1);
  const [renewal] = (await openInvoices(S1.tenant._id)).filter((i) => i.kind === "renewal");
  assert.equal(renewal.planSnapshot.code, "basic");
  assert.equal(renewal.period.start.getTime(), end.getTime());
  assert.equal(renewal.dueAt.getTime(), end.getTime());
  assert.equal((await runBillingRenewals({ now: new Date(end.getTime() - 2 * DAY) })).invoices, 0, "idempotent");

  const r1 = await runBillingRenewals({ now: new Date(end.getTime() + 3600e3) });
  assert.equal(r1.pastDue, 1);
  let sub = await subOf(S1.tenant._id);
  assert.equal(sub.status, "past_due");
  assert.equal(sub.graceEndsAt.getTime(), end.getTime() + 7 * DAY);
  await runBillingRenewals({ now: new Date(end.getTime() + 3 * DAY + 2 * 3600e3) });
  await runBillingRenewals({ now: new Date(end.getTime() + 3 * DAY + 3 * 3600e3) });
  await runBillingRenewals({ now: new Date(end.getTime() + 6 * DAY + 2 * 3600e3) });
  const pd = eventsOf("SUBSCRIPTION_PAST_DUE", S1.tenant._id).map((x) => x.p.day);
  assert.deepEqual(pd, [0, 3, 6]);
  assert.equal((await Tenant.findById(S1.tenant._id).lean()).status, "active", "still selling in grace");

  const r3 = await runBillingRenewals({ now: new Date(end.getTime() + 7 * DAY + 3600e3) });
  assert.equal(r3.paused, 1);
  sub = await subOf(S1.tenant._id);
  assert.equal(sub.status, "paused");
  let tenant = await Tenant.findById(S1.tenant._id).lean();
  assert.equal(tenant.status, "paused");
  assert.equal(tenant.statusReason, BILLING_PAUSE_REASONS.overdue);
  await tick();
  assert.equal(eventsOf("SUBSCRIPTION_PAUSED", S1.tenant._id).length, 1);

  const paid = await payOnline(S1.token, renewal._id);
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  sub = await subOf(S1.tenant._id);
  assert.equal(sub.status, "active");
  assert.equal(sub.planSnapshot.code, "basic", "downgrade applied at renewal");
  assert.equal(sub.pendingPlanId, null);
  assert.equal(sub.currentPeriodStart.getTime(), end.getTime());
  tenant = await Tenant.findById(S1.tenant._id).lean();
  assert.equal(tenant.status, "active");
  await tick();
  assert.ok(eventsOf("SUBSCRIPTION_RESUMED", S1.tenant._id).length >= 1);
});

await check("billing pause does not resume a store paused for another reason", async () => {
  const { setTenantStatus } = await import("../modules/tenants/service.js");
  await setTenantStatus(S1.tenant._id, "paused", { reason: "Quality review", by: platform._id });
  const inv = await call("POST", `/admin/subscriptions/${S1.tenant._id}/invoices`, {
    token: T.platform,
    json: { kind: "custom", lines: [{ description: "Onboarding support", amount: 100 }] },
  });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  assert.equal(inv.data.kind, "custom");
  assert.equal(inv.data.total, 118);
  await call("POST", `/admin/subscriptions/invoices/${inv.data.id}/mark-paid`, { token: T.platform, json: { reference: "CHQ-7788", mode: "cheque" } });
  assert.equal((await Tenant.findById(S1.tenant._id).lean()).statusReason, "Quality review");
  await setTenantStatus(S1.tenant._id, "active", { by: platform._id });
});

let S2;
await check("comp on an awaiting store: zero invoice settled, subscription active, store live; IGST inter-state", async () => {
  S2 = await approveNew("two", { state: "29" }); // no plan chosen -> default (cheapest public paid plan)
  const sub0 = await subOf(S2.tenant._id);
  assert.equal(sub0.planSnapshot.code, "basic");
  const [first] = await openInvoices(S2.tenant._id);
  assert.equal(first.supplyType, "inter");
  assert.equal(first.tax.igst, 89.82);
  const res = await call("POST", `/admin/subscriptions/${S2.tenant._id}/comp`, { token: T.platform, json: { reason: "Launch partner" } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.subscription.status, "active");
  const voided = await SubscriptionInvoice.findById(first._id).lean();
  assert.equal(voided.status, "void");
  const comp = res.data.invoices.find((i) => i.status === "paid");
  assert.equal(comp.total, 0);
  assert.match(comp.payment.reference, /Complimentary/);
  assert.equal((await Tenant.findById(S2.tenant._id).lean()).status, "active");
});

await check("discount (percent, 1 cycle) + credits on the next invoice; void gives credits back", async () => {
  const d = await call("POST", `/admin/subscriptions/${S2.tenant._id}/discount`, { token: T.platform, json: { type: "percent", value: 50, cycles: 1, reason: "Promo" } });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const c = await call("POST", `/admin/subscriptions/${S2.tenant._id}/discount`, { token: T.platform, json: { type: "credit", value: 100 } });
  assert.equal(c.data.subscription.credits, 100);
  const inv = await call("POST", `/admin/subscriptions/${S2.tenant._id}/invoices`, { token: T.platform, json: { kind: "next" } });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  assert.equal(inv.data.kind, "renewal");
  assert.equal(inv.data.subtotal, r2(499 - 249.5 - 100));
  let sub = await subOf(S2.tenant._id);
  assert.equal(sub.credits, 0);
  assert.equal(sub.discount.cyclesLeft, 0);
  const v = await call("POST", `/admin/subscriptions/invoices/${inv.data.id}/void`, { token: T.platform, json: { reason: "Re-issue" } });
  assert.equal(v.data.status, "void");
  sub = await subOf(S2.tenant._id);
  assert.equal(sub.credits, 100);
  assert.equal(sub.discount.cyclesLeft, 1);
  assert.equal((await call("POST", `/admin/subscriptions/invoices/${inv.data.id}/mark-paid`, { token: T.platform, json: { reference: "late" } })).status, 409);
});

await check("extend grace: paused (billing) -> past_due with new grace; store resumed", async () => {
  await TenantSubscription.updateOne({ tenantId: S2.tenant._id }, { $set: { status: "paused", graceEndsAt: new Date(Date.now() - DAY) } });
  const { setTenantStatus } = await import("../modules/tenants/service.js");
  await setTenantStatus(S2.tenant._id, "paused", { reason: BILLING_PAUSE_REASONS.overdue });
  const res = await call("POST", `/admin/subscriptions/${S2.tenant._id}/extend-grace`, { token: T.platform, json: { days: 5, reason: "Customer asked" } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.subscription.status, "past_due");
  assert.ok(new Date(res.data.subscription.graceEndsAt) > new Date(Date.now() + 4 * DAY));
  assert.equal((await Tenant.findById(S2.tenant._id).lean()).status, "active");
  await TenantSubscription.updateOne({ tenantId: S2.tenant._id }, { $set: { status: "active", graceEndsAt: null } });
});

await check("autopay: Razorpay plan created lazily (GST incl.), subscription starts at period end; webhooks activate + charge (idempotent) + halt", async () => {
  const setup = await call("POST", "/billing/me/autopay", { token: S2.token });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  assert.equal(setup.data.shortUrl, "https://rzp.io/i/test");
  const rzpPlan = fake.plans.at(-1);
  assert.equal(rzpPlan.item.amount, 58882);
  assert.equal(rzpPlan.period, "monthly");
  const sub0 = await subOf(S2.tenant._id);
  assert.equal(fake.subs.at(-1).start_at, Math.floor(sub0.currentPeriodEnd.getTime() / 1000));
  assert.equal((await Plan.findById(basic.id).lean()).razorpayPlanIds.monthly, rzpPlan.id);
  // Second call returns the same not-yet-authorised subscription.
  assert.equal((await call("POST", "/billing/me/autopay", { token: S2.token })).data.razorpaySubscriptionId, setup.data.razorpaySubscriptionId);

  const rzpSub = { id: setup.data.razorpaySubscriptionId, plan_id: rzpPlan.id, status: "active" };
  await processRazorpayEvent({ event: "subscription.activated", payload: { subscription: { entity: rzpSub } } });
  let sub = await subOf(S2.tenant._id);
  assert.equal(sub.billingMode, "autopay");
  assert.equal(sub.razorpaySubscriptionStatus, "active");

  const charged = { event: "subscription.charged", payload: { subscription: { entity: rzpSub }, payment: { entity: { id: "pay_auto_1", amount: 58882, status: "captured", order_id: "order_rzp_auto" } } } };
  const r = await processRazorpayEvent(charged);
  assert.equal(r.billing, true);
  await processRazorpayEvent(charged);
  const autoInv = await SubscriptionInvoice.find({ "payment.razorpayPaymentId": "pay_auto_1" }).lean();
  assert.equal(autoInv.length, 1);
  assert.equal(autoInv[0].status, "paid");
  assert.equal(autoInv[0].kind, "renewal");
  assert.equal(autoInv[0].total, 588.82);
  assert.equal(autoInv[0].period.start.getTime(), sub0.currentPeriodEnd.getTime());
  // Prepaid renewal: the period rolls when it starts (job).
  await TenantSubscription.updateOne({ tenantId: S2.tenant._id }, { $set: { currentPeriodEnd: sub0.currentPeriodEnd } });
  const roll = await runBillingRenewals({ now: new Date(sub0.currentPeriodEnd.getTime() + 60e3) });
  assert.equal(roll.renewed, 1);
  sub = await subOf(S2.tenant._id);
  assert.equal(sub.currentPeriodStart.getTime(), sub0.currentPeriodEnd.getTime());
  // The open manual renewal (from the discount test) was voided by the autopay payment.
  assert.equal((await openInvoices(S2.tenant._id)).filter((i) => i.kind === "renewal").length, 0);

  await processRazorpayEvent({ event: "subscription.halted", payload: { subscription: { entity: { ...rzpSub, status: "halted" } } } });
  sub = await subOf(S2.tenant._id);
  assert.equal(sub.billingMode, "manual");
  assert.equal(sub.razorpaySubscriptionStatus, "halted");
  await tick();
  assert.equal(eventsOf("SUBSCRIPTION_PAYMENT_FAILED", S2.tenant._id).at(-1).p.final, true);
});

await check("webhook payment.captured on a billing Razorpay order pays the invoice (order logic untouched)", async () => {
  const S3 = await approveNew("three", { planId: pro.id });
  const [inv] = await openInvoices(S3.tenant._id);
  assert.equal(inv.total, 1178.82);
  const order = await call("POST", `/billing/me/invoices/${inv._id}/pay`, { token: S3.token, json: {} });
  assert.equal(order.data.amount, 117882);
  fake.payments.set("pay_hook_1", { id: "pay_hook_1", order_id: order.data.orderId, status: "captured", amount: 117882, currency: "INR" });
  const res = await processRazorpayEvent({ event: "payment.captured", payload: { payment: { entity: { id: "pay_hook_1", order_id: order.data.orderId, amount: 117882 } } } });
  assert.equal(res.billing, true);
  assert.equal((await SubscriptionInvoice.findById(inv._id).lean()).status, "paid");
  assert.equal((await subOf(S3.tenant._id)).status, "active");
  assert.equal((await Tenant.findById(S3.tenant._id).lean()).status, "active");
  // A non-billing order still goes through the order logic (no billing match).
  const other = await processRazorpayEvent({ event: "payment.captured", payload: { payment: { entity: { id: "pay_x", order_id: "order_unknown", amount: 100 } } } });
  assert.equal(other.billing, undefined);
});

await check("legacy: ending-soon reminder once; early plan purchase starts at payment (R7); job registered", async () => {
  const until = new Date(Date.now() + 10 * DAY);
  await TenantSubscription.updateOne({ tenantId: OLD._id }, { $set: { currentPeriodEnd: until, legacyUntil: until } });
  await runBillingRenewals();
  await runBillingRenewals();
  await tick();
  assert.equal(eventsOf("SUBSCRIPTION_LEGACY_ENDING", OLD._id).length, 1);
  const me = await call("GET", "/billing/me", { token: T.old });
  assert.equal(me.data.subscription.status, "legacy");
  assert.equal(me.data.needsPlan, true);
  const choose = await call("POST", "/billing/me/plan", { token: T.old, json: { planId: basic.id, interval: "yearly" } });
  assert.equal(choose.status, 200, JSON.stringify(choose.data));
  assert.equal(choose.data.invoice.kind, "first");
  assert.equal(choose.data.invoice.subtotal, 5988);
  assert.equal(choose.data.invoice.supplyType, "inter");
  assert.equal(new Date(choose.data.invoice.dueAt).getTime(), until.getTime());
  assert.ok(Math.abs(new Date(choose.data.invoice.period.start).getTime() - Date.now()) < 60_000, "issued period starts now (re-stamped at payment)");
  assert.equal((await subOf(OLD._id)).status, "legacy", "still legacy until paid");
  const before = Date.now();
  const paid = await call("POST", `/admin/subscriptions/invoices/${choose.data.invoice.id}/mark-paid`, { token: T.platform, json: { reference: "NEFT-1" } });
  assert.equal(paid.status, 200);
  const sub = await subOf(OLD._id);
  assert.equal(sub.status, "active");
  assert.equal(sub.planSnapshot.interval, "yearly");
  assert.ok(sub.currentPeriodStart.getTime() >= before - 1000 && sub.currentPeriodStart.getTime() <= Date.now(), "paid period starts at payment, not at legacy end");
  assert.equal(sub.currentPeriodEnd.getTime(), addInterval(sub.currentPeriodStart, "yearly").getTime());
  const inv = await SubscriptionInvoice.findById(choose.data.invoice.id).lean();
  assert.equal(new Date(inv.period.start).getTime(), sub.currentPeriodStart.getTime(), "invoice period re-stamped to payment");
  assert.equal(typeof JOBS["billing-renewals"], "function");
});

await check("legacy expiry without a plan -> past_due (needsPlan) -> paused after grace", async () => {
  const X = await Tenant.create({ name: "Lapsed", slug: "lapsed", status: "active" });
  await runBillingMigrations();
  const end = new Date(Date.now() - 10 * DAY);
  await TenantSubscription.updateOne({ tenantId: X._id }, { $set: { currentPeriodEnd: end, legacyUntil: end } });
  await runBillingRenewals({ now: new Date(end.getTime() + 3600e3) });
  assert.equal((await subOf(X._id)).status, "past_due");
  await tick();
  assert.equal(eventsOf("SUBSCRIPTION_PAST_DUE", X._id)[0].p.needsPlan, true);
  await runBillingRenewals({ now: new Date(end.getTime() + 8 * DAY) });
  assert.equal((await subOf(X._id)).status, "paused");
  assert.equal((await Tenant.findById(X._id).lean()).statusReason, BILLING_PAUSE_REASONS.overdue);
});

await check("admin list / detail / billing mode / numbering", async () => {
  const list = await call("GET", "/admin/subscriptions?status=active", { token: T.platform });
  assert.equal(list.status, 200);
  assert.ok(list.data.data.length >= 3);
  assert.ok(list.data.counts.active >= 3);
  const detail = await call("GET", `/admin/subscriptions/${S1.tenant._id}`, { token: T.platform });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.subscription.tenant.name, S1.tenant.name);
  assert.ok(detail.data.invoices.length >= 3);
  assert.equal((await call("POST", `/admin/subscriptions/${S1.tenant._id}/billing-mode`, { token: T.platform, json: { billingMode: "autopay" } })).data.code, "AUTOPAY_NOT_SET_UP");
  assert.equal((await call("GET", "/admin/subscriptions", { token: S1.token })).status, 403);
  const numbers = (await SubscriptionInvoice.find({ number: { $type: "string" } }).sort({ sequence: 1 }).lean()).map((i) => i.sequence);
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1), "gap-free sequence");
  await Settings.updateOne({ key: "platform.invoicePrefix" }, { $set: { value: "PLT" } });
  invalidateSettingCache();
  const inv = await call("POST", `/admin/subscriptions/${S1.tenant._id}/invoices`, { token: T.platform, json: { kind: "custom", lines: [{ description: "Misc", amount: 10 }] } });
  assert.match(inv.data.number, /^PLT\/\d{4}\/000001$/);
});

await check("autopay verify (checkout signature) + history actors + staff billing summary + subscriber counts", async () => {
  const setup = await call("POST", "/billing/me/autopay", { token: S1.token });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  const subId = setup.data.razorpaySubscriptionId;
  const body = { razorpaySubscriptionId: subId, razorpayPaymentId: "pay_mandate_1", razorpaySignature: "bad" };
  assert.equal((await call("POST", "/billing/me/autopay/verify", { token: S1.token, json: body })).data.code, "PAYMENT_SIGNATURE");
  body.razorpaySignature = hmac(env.razorpayKeySecret, `pay_mandate_1|${subId}`);
  assert.equal((await call("POST", "/billing/me/autopay/verify", { token: S1.token, json: { ...body, razorpaySubscriptionId: "sub_other" } })).data.code, "PAYMENT_ORDER");
  let v = await call("POST", "/billing/me/autopay/verify", { token: S1.token, json: body });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.equal((await subOf(S1.tenant._id)).billingMode, "manual", "not authenticated at Razorpay yet");
  fake.subStatus.set(subId, "authenticated");
  v = await call("POST", "/billing/me/autopay/verify", { token: S1.token, json: body });
  assert.equal(v.data.billingMode, "autopay");
  const sub = await subOf(S1.tenant._id);
  assert.equal(sub.billingMode, "autopay");
  assert.equal(sub.razorpaySubscriptionStatus, "authenticated");

  const detail = await call("GET", `/admin/subscriptions/${S1.tenant._id}`, { token: T.platform });
  const verified = detail.data.subscription.history.find((h) => h.action === "autopay_authenticated");
  assert.equal(verified.by.name, S1.user.name);

  const agent = await mkUser("Agent", "agent@p3b.test", roles.support_agent, { tenantId: S1.tenant._id });
  const me = await call("GET", "/billing/me", { token: await tokenFor(agent) });
  assert.equal(me.status, 200, JSON.stringify(me.data));
  assert.equal(me.data.summary, true);
  assert.equal(me.data.subscription.status, sub.status);
  assert.equal(me.data.plan, undefined, "no prices for staff without settings access");
  assert.equal((await call("GET", "/billing/me/invoices", { token: await tokenFor(agent) })).status, 403);

  await Tenant.create({ name: "Still legacy", slug: "still-legacy", status: "active" });
  await runBillingMigrations();
  const plans = await call("GET", "/admin/plans", { token: T.platform });
  const legacyPlan = plans.data.data.find((p) => p.code === "legacy");
  const counted = await TenantSubscription.countDocuments({ planId: legacyPlan.id, status: { $in: ["awaiting_payment", "active", "past_due", "paused"] } });
  const all = await TenantSubscription.countDocuments({ planId: legacyPlan.id });
  assert.ok(all > counted, "fixture has legacy-status subscriptions");
  assert.equal(legacyPlan.subscribers, counted, "legacy / cancelled subscriptions are not counted");
});

await tick(200);
server.close();
setRazorpayClient(null);
await mongoose.disconnect();
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
