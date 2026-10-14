/**
 * Phase 2 (p2-onboarding): seller self sign-up, KYC application, checks, review queue, reapply.
 *
 * Throwaway local replica set only (the database is dropped):
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_p2o?replicaSet=rs0" node src/tests/phase2Onboarding.js
 */
import assert from "assert/strict";
import express from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { requestId } from "../middleware/requestId.js";
import { notFound, errorHandler } from "../middleware/error.js";
import { signAccessToken } from "../utils/tokens.js";
import { gstinCheckChar } from "../utils/gstin.js";
import { ensureSystemRoles } from "../seeds/index.js";
import authRoutes from "../modules/auth/routes.js";
import sellerApplicationRoutes from "../modules/sellerApplications/routes.js";
import termsRoutes from "../modules/terms/routes.js";
import privateFilesRouter from "../modules/files/routes.js";
import { User } from "../modules/users/user.model.js";
import { Role } from "../modules/rbac/role.model.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { Settings } from "../modules/settings/settings.model.js";
import { Notification } from "../modules/notifications/notification.model.js";
import { SellerApplication } from "../modules/sellerApplications/sellerApplication.model.js";
import { registerApplicant } from "../modules/sellerApplications/service.js";
import * as tenantService from "../modules/tenants/service.js";
import { registerSellerApplicationListeners } from "../modules/notifications/service.js";
import { storage } from "../utils/storage.js";

if (!/127\.0\.0\.1:27027\/msp_test_p2o(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_p2o database");
  process.exit(2);
}

await mongoose.connect(env.mongoUri);
await mongoose.connection.db.dropDatabase();
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes().catch(() => {})));
await storage.ensure();
registerSellerApplicationListeners();

const app = express();
app.set("trust proxy", false);
app.use(requestId);
app.use(express.json());
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/seller-applications", sellerApplicationRoutes);
app.use("/api/v1/terms", termsRoutes);
app.use("/api/v1/files", privateFilesRouter);
app.use(notFound);
app.use(errorHandler);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, url, { token, json, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + (url.startsWith("/api/") ? url : "/api/v1" + url), {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : body,
  });
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

const roles = await ensureSystemRoles();
const gstinFor = (state, pan) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};
const PAN1 = "AAPFU0939F";
const G1 = gstinFor("27", PAN1); // Maharashtra
const PAN2 = "AABCA1234A";
const G2 = gstinFor("07", PAN2); // Delhi
const PAN3 = "AAACB5678C";
const G3 = gstinFor("29", PAN3); // Karnataka (taken by a live store below)

const platform = await User.create({
  name: "Platform",
  email: "pa@p2o.test",
  passwordHash: "x",
  roleId: roles.super_admin._id,
  status: "active",
  emailVerified: true,
});
const buyer = await User.create({ name: "Buyer", email: "buyer@p2o.test", passwordHash: "x", roleId: roles.buyer._id, status: "active", emailVerified: true });
const PA = signAccessToken({ sub: String(platform._id), tenantId: null, tv: 0 });
const BUYER = signAccessToken({ sub: String(buyer._id), tenantId: null, tv: 0 });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
async function uploadDoc(token, type) {
  const form = new FormData();
  form.append("type", type);
  form.append("file", new Blob([PNG], { type: "image/png" }), `${type}.png`);
  const r = await call("POST", "/seller-applications/me/documents", { token, body: form });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.fileId;
}

async function login(email, password = "Seller#Pass1") {
  const r = await call("POST", "/auth/login", { json: { email, password } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

const address = (state, pin) => ({ contactName: "Owner", phone: "9876500000", addressLine1: "12 Market Road", city: "City", state, postalCode: pin });

async function fullDraft(token, { gstin, pan, state = "Maharashtra", pin = "400001", account = "501234567890", phone = "9876543210" }) {
  const docs = [];
  for (const type of ["gst_certificate", "pan_card", "cancelled_cheque"]) docs.push({ type, fileId: await uploadDoc(token, type) });
  const terms = await call("GET", "/terms/seller/current");
  const r = await call("PATCH", "/seller-applications/me", {
    token,
    json: {
      phone,
      business: { legalName: "Test Traders Pvt Ltd", tradeName: "Test Traders", businessType: "private_limited", gstin, pan },
      registeredAddress: address(state, pin),
      pickupAddress: address(state, pin),
      bank: { holderName: "Test Traders", accountNumber: account, ifsc: "HDFC0001234" },
      documents: docs,
      termsVersion: terms.data.version,
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

/* ------------------------------------------------------------------ register / login */

let S1; // applicant 1 token
await check("register: creates applicant + draft; 201", async () => {
  const r = await call("POST", "/seller-applications/register", {
    json: { name: "Seller One", email: "s1@p2o.test", password: "Seller#Pass1", phone: "9876543210", businessName: "Test Traders" },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.applicationId);
  const user = await User.findOne({ email: "s1@p2o.test" }).populate("roleId");
  assert.equal(user.roleId.slug, "seller_applicant");
  assert.equal(user.tenantId, null);
  assert.equal(user.emailVerified, false);
});

await check("register: email of an existing buyer / applicant → 409 EMAIL_IN_USE", async () => {
  for (const email of ["buyer@p2o.test", "S1@p2o.test"]) {
    const r = await call("POST", "/seller-applications/register", { json: { name: "Dup", email, password: "Seller#Pass1", phone: "9876543210" } });
    assert.equal(r.status, 409);
    assert.equal(r.data.code, "EMAIL_IN_USE");
    assert.match(r.data.message, /different email/);
  }
});

await check("login + /auth/me work for an applicant (isSellerApplicant)", async () => {
  const out = await login("s1@p2o.test");
  assert.equal(out.user.isSellerApplicant, true);
  S1 = out.accessToken;
  const me = await call("GET", "/auth/me", { token: S1 });
  assert.equal(me.status, 200);
  assert.equal(me.data.isSellerApplicant, true);
});

await check("applicant cannot use the review queue; buyer cannot edit an application", async () => {
  assert.equal((await call("GET", "/seller-applications", { token: S1 })).status, 403);
  assert.equal((await call("PATCH", "/seller-applications/me", { token: BUYER, json: { phone: "9999999999" } })).status, 403);
});

await check("terms: GET /terms/seller/current returns version + text", async () => {
  const r = await call("GET", "/terms/seller/current");
  assert.equal(r.status, 200);
  assert.ok(r.data.version);
  assert.ok(r.data.text.length > 20);
});

/* ------------------------------------------------------------------ draft validation */

await check("PATCH: invalid GSTIN / PAN / IFSC → 400 with fields", async () => {
  const r = await call("PATCH", "/seller-applications/me", {
    token: S1,
    json: { business: { gstin: "27AAPFU0939F1ZX", pan: "12345" }, bank: { ifsc: "HDFC1234" } },
  });
  assert.equal(r.status, 400);
  assert.ok(r.data.fields["business.gstin"]);
  assert.ok(r.data.fields["business.pan"]);
  assert.ok(r.data.fields["bank.ifsc"]);
});

await check("PATCH: documents must be the applicant's own kyc uploads", async () => {
  const other = await registerApplicant({ name: "Other", email: "other@p2o.test", password: "Seller#Pass1", phone: "9000000001" });
  assert.ok(other.applicationId);
  const otherTok = (await login("other@p2o.test")).accessToken;
  const foreign = await uploadDoc(otherTok, "pan_card");
  const r = await call("PATCH", "/seller-applications/me", { token: S1, json: { documents: [{ type: "pan_card", fileId: foreign }] } });
  assert.equal(r.status, 400);
  assert.ok(r.data.fields["documents.0.fileId"]);
});

await check("PATCH: stale terms version → 409 TERMS_OUTDATED", async () => {
  const r = await call("PATCH", "/seller-applications/me", { token: S1, json: { termsVersion: "1999-01-01" } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "TERMS_OUTDATED");
});

await check("submit: unverified email → 403 EMAIL_NOT_VERIFIED", async () => {
  const r = await call("POST", "/seller-applications/me/submit", { token: S1, json: {} });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, "EMAIL_NOT_VERIFIED");
});

await check("submit: incomplete → 400 listing missing fields", async () => {
  await User.updateOne({ email: "s1@p2o.test" }, { $set: { emailVerified: true } });
  const r = await call("POST", "/seller-applications/me/submit", { token: S1, json: {} });
  assert.equal(r.status, 400);
  for (const k of ["business.gstin", "bank.accountNumber", "documents.gst_certificate", "pickupAddress.postalCode", "termsVersion"]) {
    assert.ok(r.data.fields[k], `missing ${k}`);
  }
});

await check("bank number stored encrypted; applicant sees only last4", async () => {
  const me = await fullDraft(S1, { gstin: G1, pan: PAN1 });
  assert.equal(me.bank.accountLast4, "7890");
  assert.equal(me.bank.accountNumber, undefined);
  assert.ok(!JSON.stringify(me).includes("501234567890"));
  const raw = await SellerApplication.findOne({ email: "s1@p2o.test" }).lean();
  assert.match(raw.bank.accountNumberEnc, /^v1:/);
  assert.ok(!raw.bank.accountNumberEnc.includes("501234567890"));
  assert.equal(me.documents.length, 3);
  assert.match(me.documents[0].url, /sig=/);
  const file = await fetch(base + me.documents[0].url);
  assert.equal(file.status, 200);
});

await check("submit: food seller needs FSSAI number + expiry + document", async () => {
  await call("PATCH", "/seller-applications/me", { token: S1, json: { sellsFood: true } });
  const r = await call("POST", "/seller-applications/me/submit", { token: S1, json: {} });
  assert.equal(r.status, 400);
  assert.ok(r.data.fields["fssai.number"]);
  assert.ok(r.data.fields["fssai.expiresAt"]);
  assert.ok(r.data.fields["documents.fssai"]);
  const me = (await call("GET", "/seller-applications/me", { token: S1 })).data;
  const fssaiDoc = await uploadDoc(S1, "fssai");
  const r2 = await call("PATCH", "/seller-applications/me", {
    token: S1,
    json: {
      fssai: { number: "11112222333344", expiresAt: new Date(Date.now() + 365 * 86400000).toISOString() },
      documents: [...me.documents.map((d) => ({ type: d.type, fileId: d.fileId })), { type: "fssai", fileId: fssaiDoc }],
    },
  });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  assert.deepEqual(r2.data.missing, []);
});

await check("submit: PAN must match GSTIN → 400 PAN_GSTIN_MISMATCH", async () => {
  await call("PATCH", "/seller-applications/me", { token: S1, json: { business: { pan: PAN2 } } });
  const r = await call("POST", "/seller-applications/me/submit", { token: S1, json: {} });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "PAN_GSTIN_MISMATCH");
  await call("PATCH", "/seller-applications/me", { token: S1, json: { business: { pan: PAN1 } } });
});

let APP1;
await check("submit: success; checks recorded (gstin, pan, state match)", async () => {
  const r = await call("POST", "/seller-applications/me/submit", { token: S1, json: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, "submitted");
  APP1 = r.data.id;
  const raw = await SellerApplication.findById(APP1).lean();
  assert.equal(raw.checks.gstinValid, true);
  assert.equal(raw.checks.panMatchesGstin, true);
  assert.equal(raw.checks.stateMatches, true);
  assert.equal(raw.checks.gstinStateCode, "MH");
  const again = await call("PATCH", "/seller-applications/me", { token: S1, json: { phone: "9876543211" } });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, "NOT_EDITABLE");
});

/* ------------------------------------------------------------------ duplicates */

let S2;
let APP2;
await check("duplicates: same bank account / phone / PAN flagged; state mismatch flagged", async () => {
  await registerApplicant({ name: "Seller Two", email: "s2@p2o.test", password: "Seller#Pass1", phone: "9876543210" });
  await User.updateOne({ email: "s2@p2o.test" }, { $set: { emailVerified: true } });
  S2 = (await login("s2@p2o.test")).accessToken;
  // Same PAN/GSTIN entity in another state's GSTIN is unusual; here: different GSTIN, same bank + phone, pickup in MH vs GSTIN DL.
  await fullDraft(S2, { gstin: G2, pan: PAN2, state: "Maharashtra", pin: "400001" });
  const r = await call("POST", "/seller-applications/me/submit", { token: S2, json: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  APP2 = r.data.id;
  const raw = await SellerApplication.findById(APP2).lean();
  assert.equal(raw.checks.stateMatches, false);
  const fields = raw.checks.duplicates.map((d) => `${d.field}:${d.matchType}`);
  assert.ok(fields.includes("bank:application"), fields.join(","));
  assert.ok(fields.includes("phone:application"), fields.join(","));
  assert.ok(raw.checks.duplicates.every((d) => String(d.ref) === APP1));
});

await check("duplicates: exact GSTIN of an approved (live) store → 409 GSTIN_EXISTS", async () => {
  await Tenant.create({ name: "Live Store", slug: "live-store", status: "active", businessProfile: { legalName: "Live", gstin: G3 } });
  await registerApplicant({ name: "Seller Three", email: "s3@p2o.test", password: "Seller#Pass1", phone: "9000000003" });
  await User.updateOne({ email: "s3@p2o.test" }, { $set: { emailVerified: true } });
  const S3 = (await login("s3@p2o.test")).accessToken;
  await fullDraft(S3, { gstin: G3, pan: PAN3, state: "Karnataka", pin: "560001", account: "555566667777", phone: "9000000003" });
  const r = await call("POST", "/seller-applications/me/submit", { token: S3, json: {} });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "GSTIN_EXISTS");
});

/* ------------------------------------------------------------------ review queue */

await check("admin list: filters + counts per status; no full bank number", async () => {
  const r = await call("GET", "/seller-applications?status=submitted", { token: PA });
  assert.equal(r.status, 200);
  assert.equal(r.data.data.length, 2);
  assert.equal(r.data.counts.submitted, 2);
  assert.ok(r.data.counts.draft >= 2);
  assert.ok(!JSON.stringify(r.data).includes("501234567890"));
  const q = await call("GET", `/seller-applications?q=${G2}`, { token: PA });
  assert.equal(q.data.data.length, 1);
});

await check("admin detail: full bank number + signed doc links + duplicates", async () => {
  const r = await call("GET", `/seller-applications/${APP2}`, { token: PA });
  assert.equal(r.status, 200);
  assert.equal(r.data.bank.accountNumber, "501234567890");
  assert.ok(r.data.documents.every((d) => /sig=/.test(d.url)));
  assert.ok(r.data.checks.duplicates.length >= 2);
  assert.equal(r.data.applicant.email, "s2@p2o.test");
});

await check("more-info loop: start-review → request-info → edit → resubmit", async () => {
  let r = await call("POST", `/seller-applications/${APP1}/start-review`, { token: PA, json: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, "under_review");
  r = await call("POST", `/seller-applications/${APP1}/request-info`, { token: PA, json: { message: "Upload a clearer PAN card" } });
  assert.equal(r.data.status, "more_info_needed");
  const me = await call("GET", "/seller-applications/me", { token: S1 });
  assert.equal(me.data.moreInfoRequest.message, "Upload a clearer PAN card");
  const pan = await uploadDoc(S1, "pan_card");
  const docs = me.data.documents.filter((d) => d.type !== "pan_card").map((d) => ({ type: d.type, fileId: d.fileId }));
  r = await call("PATCH", "/seller-applications/me", { token: S1, json: { documents: [...docs, { type: "pan_card", fileId: pan }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call("POST", "/seller-applications/me/submit", { token: S1, json: {} });
  assert.equal(r.data.status, "submitted");
  const raw = await SellerApplication.findById(APP1).lean();
  assert.deepEqual(
    raw.history.map((h) => h.to),
    ["draft", "submitted", "under_review", "more_info_needed", "submitted"]
  );
});

await check("notes: reviewer note stored (admin only)", async () => {
  const r = await call("POST", `/seller-applications/${APP2}/notes`, { token: PA, json: { text: "Same bank as another applicant" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.reviewerNotes.length, 1);
  const mine = await call("GET", "/seller-applications/me", { token: S2 });
  assert.equal(mine.data.reviewerNotes, undefined);
});

/* ------------------------------------------------------------------ reject + reapply */

await check("reject → reapply locked for 30 days → reapply clones into a new draft", async () => {
  let r = await call("POST", `/seller-applications/${APP2}/reject`, { token: PA, json: { reason: "Bank account belongs to another seller" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, "rejected");
  const days = (new Date(r.data.reapplyAfter) - Date.now()) / 86400000;
  assert.ok(days > 29.9 && days <= 30, String(days));
  const me = await call("GET", "/seller-applications/me", { token: S2 });
  assert.equal(me.data.rejection.reason, "Bank account belongs to another seller");
  r = await call("POST", "/seller-applications/me/reapply", { token: S2 });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "REAPPLY_LOCKED");
  assert.ok(r.data.reapplyAfter);
  await SellerApplication.updateOne({ _id: APP2 }, { $set: { reapplyAfter: new Date(Date.now() - 1000) } });
  r = await call("POST", "/seller-applications/me/reapply", { token: S2 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.status, "draft");
  assert.notEqual(String(r.data.id), APP2);
  assert.equal(String(r.data.previousApplicationId), APP2);
  assert.equal(r.data.business.gstin, G2);
  assert.equal(r.data.termsVersion, "");
  assert.equal((await SellerApplication.findById(APP2).lean()).status, "rejected");
  r = await call("POST", "/seller-applications/me/reapply", { token: S2 });
  assert.equal(r.status, 409);
});

/* ------------------------------------------------------------------ approve */

await check("approve → store created, applicant becomes tenant_admin", async () => {
  const r = await call("POST", `/seller-applications/${APP1}/approve`, { token: PA, json: { note: "All documents verified" } });
  if (r.status === 501) throw new Error("createTenantFromApplication not available (p2-states)");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, "approved");
  assert.ok(r.data.tenantId);
  const tenant = await Tenant.findById(r.data.tenantId).lean();
  assert.equal(tenant.status, "active");
  assert.equal(tenant.businessProfile.gstin, G1);
  const user = await User.findOne({ email: "s1@p2o.test" }).lean();
  assert.equal(String(user.tenantId), String(tenant._id));
  const role = await Role.findById(user.roleId).lean();
  assert.equal(role.slug, "tenant_admin");
  const me = await call("GET", "/auth/me", { token: S1 });
  assert.equal(me.status, 200);
  assert.equal(me.data.isSellerApplicant, false);
  assert.equal(String(me.data.tenantId), String(tenant._id));
  const again = await call("POST", `/seller-applications/${APP1}/approve`, { token: PA, json: {} });
  assert.equal(again.status, 409);
});

await check("approved GSTIN now blocks other applications (GSTIN_EXISTS)", async () => {
  await registerApplicant({ name: "Copycat", email: "s4@p2o.test", password: "Seller#Pass1", phone: "9000000004" });
  await User.updateOne({ email: "s4@p2o.test" }, { $set: { emailVerified: true } });
  const S4 = (await login("s4@p2o.test")).accessToken;
  await fullDraft(S4, { gstin: G1, pan: PAN1, account: "999988887777", phone: "9000000004" });
  const r = await call("POST", "/seller-applications/me/submit", { token: S4, json: {} });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "GSTIN_EXISTS");
});

await check("notifications: applicant + admin in-app notifications were created", async () => {
  await sleep(300);
  const s1 = await User.findOne({ email: "s1@p2o.test" }).lean();
  const s2 = await User.findOne({ email: "s2@p2o.test" }).lean();
  const events1 = (await Notification.find({ userId: s1._id }).lean()).map((n) => n.event);
  for (const e of ["SELLER_APPLIED", "SELLER_APPLICATION_SUBMITTED", "SELLER_MORE_INFO", "SELLER_APPROVED"]) assert.ok(events1.includes(e), `${e} in ${events1}`);
  const events2 = (await Notification.find({ userId: s2._id }).lean()).map((n) => n.event);
  assert.ok(events2.includes("SELLER_REJECTED"));
  assert.ok(await Notification.exists({ userId: null, event: "SELLER_APPLICATION_SUBMITTED", "audience.roleSlug": "super_admin" }));
  const inbox = await call("GET", "/seller-applications/me/notifications", { token: S2 });
  assert.equal(inbox.status, 200, JSON.stringify(inbox.data));
  assert.ok(inbox.data.data.some((n) => n.event === "SELLER_REJECTED"));
});

await check("terms version change requires re-acceptance", async () => {
  await Settings.create({ scope: "platform", tenantId: null, key: "seller.termsVersion", value: { version: "2027-01-01", url: "", text: "" } });
  const me = await call("GET", "/seller-applications/me", { token: S2 });
  assert.equal(me.data.currentTermsVersion, "2027-01-01");
  assert.equal(me.data.termsCurrent, false);
  assert.ok(me.data.missing.includes("termsVersion"));
});

/* ------------------------------------------------------------------ web-UI follow-ups */

await check("admin views: history[].by / reviewerNotes[].by resolved to { id, name, email }", async () => {
  const r = await call("GET", `/seller-applications/${APP1}`, { token: PA });
  assert.equal(r.status, 200);
  const reg = r.data.history.find((h) => h.to === "draft");
  assert.equal(reg.by.email, "s1@p2o.test");
  const approved = r.data.history.find((h) => h.to === "approved");
  assert.deepEqual({ name: approved.by.name, email: approved.by.email }, { name: "Platform", email: "pa@p2o.test" });
  assert.equal(r.data.reviewerNotes[0].by.email, "pa@p2o.test");
  const list = await call("GET", "/seller-applications?status=approved", { token: PA });
  assert.equal(list.data.data[0].history.at(-1).by.email, "pa@p2o.test");
  const mine = await call("GET", "/seller-applications/me", { token: S2 });
  assert.equal(mine.data.history[0].by, undefined, "applicant view has no 'by'");
});

await check("applicant notifications: unread-count, mark one read, mark all read", async () => {
  let inbox = await call("GET", "/seller-applications/me/notifications", { token: S2 });
  const first = inbox.data.data.find((n) => !n.readAt);
  assert.ok(first, "an unread notification");
  let c = await call("GET", "/seller-applications/me/notifications/unread-count", { token: S2 });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const before = c.data.unread;
  assert.ok(before >= 1);
  const one = await call("POST", `/seller-applications/me/notifications/${first._id}/read`, { token: S2 });
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.ok(one.data.readAt);
  c = await call("GET", "/seller-applications/me/notifications/unread-count", { token: S2 });
  assert.equal(c.data.unread, before - 1);
  const all = await call("POST", "/seller-applications/me/notifications/read-all", { token: S2 });
  assert.equal(all.status, 200);
  c = await call("GET", "/seller-applications/me/notifications/unread-count", { token: S2 });
  assert.equal(c.data.unread, 0);
  const s1n = await Notification.findOne({ userId: (await User.findOne({ email: "s1@p2o.test" }))._id }).lean();
  const foreign = await call("POST", `/seller-applications/me/notifications/${s1n._id}/read`, { token: S2 });
  assert.equal(foreign.status, 404);
  const bad = await call("POST", "/seller-applications/me/notifications/nope/read", { token: S2 });
  assert.equal(bad.status, 400);
});

await check("/auth/me: staff see tenant status + statusReason", async () => {
  const s1 = await User.findOne({ email: "s1@p2o.test" }).lean();
  await tenantService.setTenantStatus(s1.tenantId, "paused", { reason: "Subscription past due", by: platform._id });
  const me = await call("GET", "/auth/me", { token: S1 });
  assert.equal(me.status, 200, JSON.stringify(me.data));
  assert.equal(me.data.tenant.status, "paused");
  assert.equal(me.data.tenant.statusReason, "Subscription past due");
  await tenantService.setTenantStatus(s1.tenantId, "active", { by: platform._id });
  const again = await call("GET", "/auth/me", { token: S1 });
  assert.equal(again.data.tenant.statusReason, "");
});

await check("/auth/resend-verification works for seller applicants (by email and signed in)", async () => {
  await registerApplicant({ name: "Unverified", email: "s6@p2o.test", password: "Seller#Pass1", phone: "9000000006" });
  const before = (await User.findOne({ email: "s6@p2o.test" }).select("+emailVerifyTokenHash").lean()).emailVerifyTokenHash;
  assert.ok(before);
  let r = await call("POST", "/auth/resend-verification", { json: { email: "s6@p2o.test" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const mid = (await User.findOne({ email: "s6@p2o.test" }).select("+emailVerifyTokenHash").lean()).emailVerifyTokenHash;
  assert.notEqual(mid, before, "new token issued");
  const tok = (await login("s6@p2o.test")).accessToken;
  r = await call("POST", "/auth/resend-verification", { token: tok, json: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.notEqual((await User.findOne({ email: "s6@p2o.test" }).select("+emailVerifyTokenHash").lean()).emailVerifyTokenHash, mid);
});
await sleep(300); // let async notification listeners finish before disconnecting

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
server.close();
await mongoose.disconnect();
