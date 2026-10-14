/**
 * QA round 2 (set A): R1 paused-store application view, R3/Q1 offer approval + rejection,
 * R4 identity lock / GSTIN on admin edit, R5/R9 phone + website formats, R12 deliberate 5xx
 * messages, R13 applicant in-app reason, R14 duplicate checks refreshed on review, R15 pickup
 * formatting, R16 new-password policy + approval email payment line.
 * (R7 — legacy early purchase — is covered in phase3Billing.js.)
 *
 * Throwaway local replica set only (the database is dropped):
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_q2a?replicaSet=rs0" node src/tests/qaRound2A.js
 */
import assert from "assert/strict";
import express from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { SELLER_EVENTS } from "../config/constants.js";
import { requestId } from "../middleware/requestId.js";
import { notFound, errorHandler } from "../middleware/error.js";
import { AppError } from "../utils/AppError.js";
import { signAccessToken } from "../utils/tokens.js";
import { gstinCheckChar } from "../utils/gstin.js";
import { emitDomain } from "../utils/events.js";
import { isIndianPhone, isHttpUrl } from "../utils/phone.js";
import { ensureSystemRoles } from "../seeds/index.js";
import v1 from "../routes/v1.js";
import { User } from "../modules/users/user.model.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { Notification } from "../modules/notifications/notification.model.js";
import { Offer } from "../modules/pricing/offer.model.js";
import { SellerApplication } from "../modules/sellerApplications/sellerApplication.model.js";
import { registerApplicant } from "../modules/sellerApplications/service.js";
import { geocodeAddress } from "../modules/location/service.js";
import { registerNotificationListeners } from "../modules/notifications/service.js";
import { TenantSubscription } from "../modules/billing/subscription.model.js";

if (!/127\.0\.0\.1:27027\/msp_test_q2a(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_q2a database");
  process.exit(2);
}

await mongoose.connect(env.mongoUri);
await mongoose.connection.db.dropDatabase();
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes().catch(() => {})));
registerNotificationListeners();

const app = express();
app.use(requestId);
app.use(express.json());
// R12 probes: deliberate operational 503 vs internal faults.
app.get("/probe/503", () => {
  throw new AppError(503, "Online payment is not configured. Add Razorpay keys.", "PAYMENT_UNAVAILABLE");
});
app.get("/probe/500", () => {
  throw new AppError(500, "KYC_ENCRYPTION_KEY is not configured", "SERVER_ERROR");
});
app.get("/probe/boom", () => {
  throw new Error("secret stack detail mongodb://user:pw@host");
});
app.use("/api/v1", v1);
app.use(notFound);
app.use(errorHandler);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, url, { token, json, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (json !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(base + (url.startsWith("/probe") ? url : "/api/v1" + url), { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(50);
  }
}

const roles = await ensureSystemRoles();
const tokenFor = async (user) => {
  const fresh = await User.findById(user._id).lean();
  return signAccessToken({ sub: String(fresh._id), tenantId: fresh.tenantId ? String(fresh.tenantId) : null, tv: fresh.tokenVersion || 0 });
};
const gstinFor = (state, pan) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};
const G1 = gstinFor("27", "AAPFU0939F");
const G2 = gstinFor("07", "AABCA1234A");

let seq = 0;
async function mkStore(name, { status = "active", businessProfile = {} } = {}) {
  seq += 1;
  const tenant = await Tenant.create({ name, slug: `q2a-${seq}`, status, businessProfile });
  const admin = await User.create({
    name: `${name} admin`,
    email: `admin${seq}@q2a.test`,
    passwordHash: "x",
    roleId: roles.tenant_admin._id,
    tenantId: tenant._id,
    status: "active",
    emailVerified: true,
  });
  return { tenant, admin, token: await tokenFor(admin) };
}
const platform = await User.create({ name: "Platform", email: "pa@q2a.test", passwordHash: "x", roleId: roles.super_admin._id, status: "active", emailVerified: true });
const PA = await tokenFor(platform);

/* ------------------------------------------------------------------ R1 */

await check("R1: staff of a PAUSED store can read their own seller application (other applicant routes stay blocked)", async () => {
  const reg = await registerApplicant({ name: "Paused Seller", email: "paused@q2a.test", password: "Seller#Pass1", phone: "9876500001" });
  const tenant = await Tenant.create({ name: "Paused Store", slug: "q2a-paused", status: "paused", statusReason: "awaiting_payment" });
  const user = await User.findOneAndUpdate({ email: "paused@q2a.test" }, { $set: { roleId: roles.tenant_admin._id, tenantId: tenant._id, emailVerified: true } }, { new: true });
  await SellerApplication.updateOne({ _id: reg.applicationId }, { $set: { status: "approved", tenantId: tenant._id } });
  const token = await tokenFor(user);
  const me = await call("GET", "/seller-applications/me", { token });
  assert.equal(me.status, 200, JSON.stringify(me.data));
  assert.equal(me.data.status, "approved");
  const link = await call("GET", "/seller-applications/me/documents/0123456789abcdef01234567/link", { token });
  assert.notEqual(link.data?.code, "STORE_PAUSED", "document link GET is allowed through the pause gate");
  const patch = await call("PATCH", "/seller-applications/me", { token, json: { phone: "9876500002" } });
  assert.equal(patch.status, 403);
  assert.equal(patch.data.code, "STORE_PAUSED");
  const products = await call("GET", "/products", { token });
  assert.equal(products.data.code, "STORE_PAUSED");
});

/* ------------------------------------------------------------------ Q1 / R3 */

const shop = await mkStore("Offer Shop");
const otherShop = await mkStore("Other Shop");
const window = () => ({ startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 864e5).toISOString() });

await check("Q1: tenant admin (even with pricing.approve) can't self-activate an offer: create 'active' -> pending_approval", async () => {
  // tenant_admin keeps pricing.approve (it still approves its own price lists).
  assert.ok(roles.tenant_admin.permissions.includes("pricing.approve"));
  const r = await call("POST", "/offers", { token: shop.token, json: { name: "Self live", type: "percent", value: 10, status: "active", ...window() } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.status, "pending_approval");
});

await check("Q1: store staff can't approve or reject offers (403); edits to a live offer's price go back to pending", async () => {
  const off = await Offer.create({ tenantId: shop.tenant._id, name: "Pending", value: 5, status: "pending_approval", startsAt: new Date(), endsAt: new Date(Date.now() + 864e5) });
  const approve = await call("POST", `/offers/${off._id}/approve`, { token: shop.token });
  assert.equal(approve.status, 403, JSON.stringify(approve.data));
  const reject = await call("POST", `/offers/${off._id}/reject`, { token: shop.token, json: { reason: "nope nope" } });
  assert.equal(reject.status, 403);
  const live = await Offer.create({ tenantId: shop.tenant._id, name: "Live", value: 5, status: "active", startsAt: new Date(), endsAt: new Date(Date.now() + 864e5) });
  const edit = await call("PATCH", `/offers/${live._id}`, { token: shop.token, json: { value: 7 } });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal(edit.data.status, "pending_approval");
});

await check("Q1: coupons stay self-service (created active by the store)", async () => {
  const r = await call("POST", "/coupons", { token: shop.token, json: { code: "SELF10", name: "Self", type: "percent", value: 10, ...window() } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.status, "active");
});

let rejectedId;
await check("R3: platform admin rejects with a required reason; seller sees status + reason; notified in-app", async () => {
  const off = await Offer.create({ tenantId: shop.tenant._id, name: "Too deep", value: 60, status: "pending_approval", startsAt: new Date(), endsAt: new Date(Date.now() + 864e5) });
  rejectedId = off._id;
  const noReason = await call("POST", `/offers/${off._id}/reject`, { token: PA, json: {} });
  assert.equal(noReason.status, 400);
  const r = await call("POST", `/offers/${off._id}/reject`, { token: PA, json: { reason: "Discount above the 50% category cap" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, "rejected");
  assert.equal(r.data.rejectionReason, "Discount above the 50% category cap");
  assert.equal(r.data.tenantId.name, "Offer Shop");
  const again = await call("POST", `/offers/${off._id}/reject`, { token: PA, json: { reason: "again again" } });
  assert.equal(again.status, 409);
  const mine = await call("GET", "/offers?status=rejected", { token: shop.token });
  assert.equal(mine.status, 200);
  const row = mine.data.data.find((o) => String(o._id) === String(off._id));
  assert.ok(row, "seller lists the rejected offer");
  assert.equal(row.rejectionReason, "Discount above the 50% category cap");
  const n = await waitFor(() => Notification.findOne({ event: "OFFER_REJECTED", tenantId: shop.tenant._id }).lean());
  assert.ok(n, "OFFER_REJECTED notification");
  assert.match(n.body, /50% category cap/);
  assert.equal(n.audience?.type, "staff");
});

await check("R3: rejected offer can be resubmitted (reason cleared) and then approved by the platform", async () => {
  const resub = await call("PATCH", `/offers/${rejectedId}`, { token: shop.token, json: { value: 40, status: "pending_approval" } });
  assert.equal(resub.status, 200, JSON.stringify(resub.data));
  assert.equal(resub.data.status, "pending_approval");
  assert.equal(resub.data.rejectionReason, "");
  const ok = await call("POST", `/offers/${rejectedId}/approve`, { token: PA });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, "active");
  const other = await call("POST", `/offers/${rejectedId}/reject`, { token: otherShop.token, json: { reason: "not mine" } });
  assert.equal(other.status, 403);
});

/* ------------------------------------------------------------------ R4 */

await check("R4: admin can't clear a GSTIN; identity-locked legal name + GSTIN are read-only (other fields editable)", async () => {
  const s = await mkStore("Locked Co", { businessProfile: { legalName: "Locked Co Pvt Ltd", gstin: G1 } });
  const clear = await call("PATCH", `/tenants/${s.tenant._id}`, { token: PA, json: { businessProfile: { gstin: "" } } });
  assert.ok([400, 409].includes(clear.status), JSON.stringify(clear.data));
  const gst = await call("PATCH", `/tenants/${s.tenant._id}`, { token: PA, json: { businessProfile: { gstin: G2 } } });
  assert.equal(gst.status, 409);
  assert.equal(gst.data.code, "IDENTITY_LOCKED");
  assert.ok(gst.data.fields["businessProfile.gstin"]);
  const legal = await call("PATCH", `/tenants/${s.tenant._id}`, { token: PA, json: { businessProfile: { legalName: "Renamed Ltd" } } });
  assert.equal(legal.status, 409);
  const same = await call("PATCH", `/tenants/${s.tenant._id}`, { token: PA, json: { name: "Locked Co 2", businessProfile: { legalName: "Locked Co Pvt Ltd", gstin: G1, phone: "9876543210" } } });
  assert.equal(same.status, 200, JSON.stringify(same.data));
  assert.equal(same.data.identityLocked, true);
  // Not locked (no legal name yet): a GSTIN on file still can't be cleared, a bad checksum is refused.
  const u = await mkStore("Unlocked", { businessProfile: { gstin: G2 } });
  const clear2 = await call("PATCH", `/tenants/${u.tenant._id}`, { token: PA, json: { businessProfile: { gstin: "" } } });
  assert.equal(clear2.status, 400);
  assert.equal(clear2.data.code, "GSTIN_REQUIRED");
  const bad = await call("PATCH", `/tenants/${u.tenant._id}`, { token: PA, json: { businessProfile: { gstin: `${G1.slice(0, 14)}${G1[14] === "A" ? "B" : "A"}` } } });
  assert.equal(bad.status, 400);
});

/* ------------------------------------------------------------------ R5 / R9 */

await check("R5/R9: phone + website formats (helpers)", async () => {
  for (const ok of ["9876543210", "+91 98765 43210", "+919876543210", "09876543210", "919876543210", "020-12345678", "02012345678", "+91 20 1234 5678", "080 2345 6789"]) {
    assert.ok(isIndianPhone(ok), ok);
  }
  for (const bad of ["12", "abc", "98765", "1234567890", "5876543210", "+1 415 555 0100", "98765432101234"]) assert.equal(isIndianPhone(bad), false, bad);
  for (const ok of ["https://shop.example.in", "http://acme.co/path?q=1"]) assert.ok(isHttpUrl(ok), ok);
  for (const bad of ["nope", "not a url", "shop.example.in", "ftp://x.com", "https://localhost", "javascript:alert(1)"]) assert.equal(isHttpUrl(bad), false, bad);
});

await check("R5: store profile / pickup phone + website validated by the server; empty clears", async () => {
  for (const json of [
    { businessProfile: { phone: "12" } },
    { businessProfile: { phone: "abc" } },
    { businessProfile: { website: "not a url" } },
    { pickupAddress: { phone: "98765" } },
  ]) {
    const r = await call("PATCH", "/tenants/me", { token: shop.token, json });
    assert.equal(r.status, 400, JSON.stringify(json));
    assert.equal(r.data.code, "VALIDATION_ERROR");
  }
  const ok = await call("PATCH", "/tenants/me", { token: shop.token, json: { businessProfile: { phone: "+91 98765 43210", website: "https://offer.shop.in" }, pickupAddress: { phone: "020 1234 5678" } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const cleared = await call("PATCH", "/tenants/me", { token: shop.token, json: { businessProfile: { phone: "", website: "" } } });
  assert.equal(cleared.status, 200);
  const nope = await call("PATCH", `/tenants/${shop.tenant._id}`, { token: PA, json: { businessProfile: { website: "nope" } } });
  assert.equal(nope.status, 400);
});

await check("R9: users phone format on admin create / update", async () => {
  const bad = await call("POST", "/users", { token: PA, json: { name: "Staffer", email: "st@q2a.test", password: "Staff#Pass1", phone: "98765", roleId: String(roles.tenant_admin._id), tenantId: String(shop.tenant._id) } });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  assert.ok(bad.data.fields.phone);
  const good = await call("POST", "/users", { token: PA, json: { name: "Staffer", email: "st@q2a.test", password: "Staff#Pass1", phone: "9876543211", roleId: String(roles.tenant_admin._id), tenantId: String(shop.tenant._id) } });
  assert.equal(good.status, 201, JSON.stringify(good.data));
  const id = good.data._id || good.data.id;
  assert.equal((await call("PATCH", `/users/${id}`, { token: PA, json: { phone: "98" } })).status, 400);
  assert.equal((await call("PATCH", `/users/${id}`, { token: PA, json: { phone: "" } })).status, 200);
});

/* ------------------------------------------------------------------ R16 passwords */

await check("R16: new-password policy (register, seller register, admin-created users, change); login unaffected", async () => {
  const weak = ["password", "12345678", "abcdefgh", "short1", "Password1"];
  for (const password of weak) {
    const r = await call("POST", "/auth/register", { json: { name: "Buyer", email: `b-${password}@q2a.test`, password } });
    assert.equal(r.status, 400, `register accepted ${password}`);
    assert.ok(r.data.fields?.password, password);
  }
  const s = await call("POST", "/seller-applications/register", { json: { name: "Seller", email: "sw@q2a.test", password: "password", phone: "9876500009" } });
  assert.equal(s.status, 400);
  const u = await call("POST", "/users", { token: PA, json: { name: "Weak", email: "weak@q2a.test", password: "12345678", roleId: String(roles.tenant_admin._id), tenantId: String(shop.tenant._id) } });
  assert.equal(u.status, 400);
  const ok = await call("POST", "/auth/register", { json: { name: "Buyer", email: "good@q2a.test", password: "Kirana#Pass1" } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  // Existing (pre-policy) passwords still log in: login only checks the hash.
  const bcrypt = (await import("bcryptjs")).default;
  await User.create({ name: "Old", email: "old@q2a.test", passwordHash: await bcrypt.hash("password", 4), roleId: roles.buyer._id, status: "active", emailVerified: true });
  const login = await call("POST", "/auth/login", { json: { email: "old@q2a.test", password: "password" } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const change = await call("POST", "/auth/change-password", { token: login.data.accessToken, json: { currentPassword: "password", newPassword: "qwerty123" } });
  assert.equal(change.status, 400);
  const reset = await call("POST", "/auth/reset-password", { json: { token: "x".repeat(20), password: "password1" } });
  assert.equal(reset.status, 400);
  assert.ok(reset.data.fields?.password);
});

/* ------------------------------------------------------------------ R12 */

await check("R12: deliberate 503 AppError keeps its message; internal 500 + unexpected errors stay masked", async () => {
  const a = await call("GET", "/probe/503");
  assert.equal(a.status, 503);
  assert.equal(a.data.code, "PAYMENT_UNAVAILABLE");
  assert.match(a.data.message, /not configured/);
  const b = await call("GET", "/probe/500");
  assert.equal(b.status, 500);
  assert.equal(b.data.message, "Server error");
  const c = await call("GET", "/probe/boom");
  assert.equal(c.status, 500);
  assert.equal(c.data.message, "Server error");
  assert.ok(!JSON.stringify(c.data).includes("mongodb://"));
});

/* ------------------------------------------------------------------ R13 + approval email */

await check("R13: applicant in-app notifications carry the reviewer's message / reject reason", async () => {
  const reg = await registerApplicant({ name: "Notif", email: "notif@q2a.test", password: "Seller#Pass1", phone: "9876500003" });
  const user = await User.findOne({ email: "notif@q2a.test" }).lean();
  emitDomain(SELLER_EVENTS.MORE_INFO, { userId: user._id, applicationId: reg.applicationId, message: "Upload a clearer PAN card" });
  emitDomain(SELLER_EVENTS.REJECTED, { userId: user._id, applicationId: reg.applicationId, reason: "GSTIN belongs to another business" });
  const more = await waitFor(() => Notification.findOne({ userId: user._id, event: SELLER_EVENTS.MORE_INFO }).lean());
  const rej = await waitFor(() => Notification.findOne({ userId: user._id, event: SELLER_EVENTS.REJECTED }).lean());
  assert.match(more.body, /Upload a clearer PAN card/);
  assert.match(rej.body, /Reason: GSTIN belongs to another business/);
});

await check("R16: approval notification mentions the first subscription payment when the store awaits it", async () => {
  const reg = await registerApplicant({ name: "Approved", email: "approved@q2a.test", password: "Seller#Pass1", phone: "9876500004" });
  const user = await User.findOne({ email: "approved@q2a.test" }).lean();
  const tenant = await Tenant.create({ name: "Approved Store", slug: "q2a-approved", status: "paused" });
  await TenantSubscription.collection.insertOne({ tenantId: tenant._id, status: "awaiting_payment", planSnapshot: { name: "Basic" }, createdAt: new Date() });
  emitDomain(SELLER_EVENTS.APPROVED, { userId: user._id, applicationId: reg.applicationId, tenantId: tenant._id, businessName: "Approved Store" });
  const n = await waitFor(() => Notification.findOne({ userId: user._id, event: SELLER_EVENTS.APPROVED }).lean());
  assert.ok(n);
  assert.match(n.body, /first subscription invoice \(Basic plan\)/);
});

/* ------------------------------------------------------------------ R14 */

await check("R14: duplicate checks are re-run (and stored) when the reviewer opens a submitted application", async () => {
  const a = await registerApplicant({ name: "First", email: "first@q2a.test", password: "Seller#Pass1", phone: "9811100099" });
  await SellerApplication.updateOne({ _id: a.applicationId }, { $set: { status: "submitted", submittedAt: new Date(), checks: { ranAt: new Date(), duplicates: [] } } });
  const before = await call("GET", `/seller-applications/${a.applicationId}`, { token: PA });
  assert.equal(before.status, 200, JSON.stringify(before.data));
  assert.equal(before.data.checks.duplicates.length, 0);
  const b = await registerApplicant({ name: "Second", email: "second@q2a.test", password: "Seller#Pass1", phone: "+91 98111 00099" });
  await SellerApplication.updateOne({ _id: b.applicationId }, { $set: { status: "submitted", submittedAt: new Date() } });
  const after = await call("GET", `/seller-applications/${a.applicationId}`, { token: PA });
  assert.equal(after.status, 200);
  assert.ok(after.data.checks.duplicates.some((d) => d.field === "phone" && d.matchType === "application"), JSON.stringify(after.data.checks));
  const stored = await SellerApplication.findById(a.applicationId).lean();
  assert.ok(stored.checks.duplicates.length >= 1, "refreshed checks are stored");
  // Decided applications keep their checks as they were.
  await SellerApplication.updateOne({ _id: a.applicationId }, { $set: { status: "rejected", checks: { ranAt: new Date(), duplicates: [] } } });
  const decided = await call("GET", `/seller-applications/${a.applicationId}`, { token: PA });
  assert.equal(decided.data.checks.duplicates.length, 0);
});

/* ------------------------------------------------------------------ R15 */

await check("R15: stub geocoder doesn't repeat city / PIN in the formatted pickup address", async () => {
  const geo = await geocodeAddress({ addressLine1: "12 Market Road", city: "Pune", state: "Maharashtra", postalCode: "411026" });
  assert.equal(geo.formatted, "12 Market Road, Pune, Maharashtra, 411026");
  const r = await call("PATCH", "/tenants/me", { token: shop.token, json: { pickupAddress: { addressLine1: "5 MG Road", city: "Pune", state: "Maharashtra", postalCode: "411026" } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((r.data.pickupAddress.formatted.match(/411026/g) || []).length, 1, r.data.pickupAddress.formatted);
});

/* ------------------------------------------------------------------ follow-up decisions */

await check("Identity correction: platform admin with a reason (recorded); without reason 409; seller still blocked", async () => {
  const s = await mkStore("Typo Co", { businessProfile: { legalName: "Typo Co Pvt Ltd", gstin: G1 } });
  const noReason = await call("PATCH", `/tenants/${s.tenant._id}`, { token: PA, json: { businessProfile: { gstin: G2 } } });
  assert.equal(noReason.status, 409);
  assert.equal(noReason.data.reasonRequired, true);
  const short = await call("PATCH", `/tenants/${s.tenant._id}`, { token: PA, json: { businessProfile: { gstin: G2 }, identityChangeReason: "typo" } });
  assert.equal(short.status, 400, "reason under 10 characters is refused by validation");
  const ok = await call("PATCH", `/tenants/${s.tenant._id}`, {
    token: PA,
    json: { businessProfile: { gstin: G2 }, identityChangeReason: "GSTIN typo found when re-checking the GST certificate" },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const t = await Tenant.findById(s.tenant._id).lean();
  assert.equal(t.businessProfile.gstin, G2);
  assert.equal(t.identityChanges.length, 1);
  assert.equal(t.identityChanges[0].from.gstin, G1);
  assert.equal(t.identityChanges[0].to.gstin, G2);
  assert.match(t.identityChanges[0].reason, /typo/);
  const bad = await call("PATCH", `/tenants/${s.tenant._id}`, {
    token: PA,
    json: { businessProfile: { gstin: `${G2.slice(0, 14)}${G2[14] === "A" ? "B" : "A"}` }, identityChangeReason: "Testing that the checksum still applies" },
  });
  assert.equal(bad.status, 400, "checksum still enforced");
  const seller = await call("PATCH", "/tenants/me", { token: s.token, json: { businessProfile: { gstin: G1 } } });
  assert.equal(seller.data.code, "IDENTITY_LOCKED");
});

await check("Paused store: can read disputes and reply (POST messages); withdraw and other writes stay blocked", async () => {
  const s = await mkStore("Paused Disputes", { status: "paused" });
  const list = await call("GET", "/disputes", { token: s.token });
  assert.equal(list.status, 200, JSON.stringify(list.data));
  const msg = await call("POST", "/disputes/0123456789abcdef01234567/messages", { token: s.token, json: { text: "Our side of the story" } });
  assert.notEqual(msg.data?.code, "STORE_PAUSED", "replying passes the pause gate");
  const wd = await call("POST", "/disputes/0123456789abcdef01234567/withdraw", { token: s.token, json: {} });
  assert.equal(wd.data?.code, "STORE_PAUSED");
});

await sleep(300);
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
server.close();
await mongoose.disconnect();
process.exit(process.exitCode || 0);
