/**
 * Auth & platform checks (Agent B). Runs against a throwaway DB only:
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_b?replicaSet=rs0" node src/tests/authPlatform.js
 * Builds a mini app with the same middleware stack as app.js plus the auth/users/roles/tenants
 * routers, so it does not depend on the commerce modules.
 */
import express from "express";
import cookieParser from "cookie-parser";
import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { connectDb } from "../config/db.js";
import { requestId } from "../middleware/requestId.js";
import { notFound, errorHandler } from "../middleware/error.js";
import { mountPlatformRoutes } from "../middleware/platform.js";
import authRoutes from "../modules/auth/routes.js";
import userRoutes from "../modules/users/routes.js";
import tenantRoutes from "../modules/tenants/routes.js";
import { roleRouter, permissionRouter } from "../modules/rbac/routes.js";
import { ensureSystemRoles, seedFoundation } from "../seeds/index.js";
import { User } from "../modules/users/user.model.js";
import { Role } from "../modules/rbac/role.model.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { hashToken } from "../utils/tokens.js";
import { storage, uploadRoot } from "../utils/storage.js";
import { isOriginAllowed } from "../config/env.js";
import { runAuthMigrations } from "../seeds/migrations.js";

if (!/127\.0\.0\.1:27027\/msp_test_(b|sf)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_b test DB");
  process.exit(2);
}

let failures = 0;
let passes = 0;
function check(name, cond, extra) {
  if (cond) {
    passes += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, extra === undefined ? "" : JSON.stringify(extra));
  }
}

const app = express();
app.set("trust proxy", 1);
app.use(requestId);
app.use(express.json());
app.use(cookieParser());
mountPlatformRoutes(app);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/roles", roleRouter);
app.use("/api/v1/permissions", permissionRouter);
app.use("/api/v1/tenants", tenantRoutes);
app.use(notFound);
app.use(errorHandler);

let base;
let ipCounter = 1;
async function call(method, url, { token, body, headers = {}, cookie } = {}) {
  const h = { "X-Forwarded-For": `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

function refreshCookie(res) {
  const raw = res.headers.get("set-cookie") || "";
  const m = raw.match(/refreshToken=([^;]*)/);
  return m ? { cookie: `refreshToken=${m[1]}`, token: decodeURIComponent(m[1]), raw } : null;
}

async function login(email, password, headers) {
  return call("POST", "/api/v1/auth/login", { body: { email, password }, headers });
}

async function main() {
  await connectDb();
  await mongoose.connection.db.dropDatabase();
  await ensureSystemRoles();
  await seedFoundation();
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).syncIndexes().catch(() => {})));

  const server = app.listen(4102);
  base = "http://127.0.0.1:4102";

  const roles = Object.fromEntries((await Role.find({ isSystem: true })).map((r) => [r.slug, r]));

  console.log("setup");
  const admin = await login(env.superAdminEmail, env.superAdminPassword);
  check("super admin login", admin.status === 200, admin.body);
  const adminToken = admin.body.accessToken;

  const tA = await call("POST", "/api/v1/tenants", {
    token: adminToken,
    body: { name: "Store A", status: "active", admin: { name: "A Admin", email: "a@x.test", password: "Password123!" }, branding: { primaryColor: "#111111" } },
  });
  const tB = await call("POST", "/api/v1/tenants", {
    token: adminToken,
    body: { name: "Store B", status: "active", admin: { name: "B Admin", email: "b@x.test", password: "Password123!" } },
  });
  check("tenants created", tA.status === 201 && tB.status === 201, [tA.body, tB.body]);
  const tenantA = tA.body._id;
  const tenantB = tB.body._id;
  const aLogin = await login("a@x.test", "Password123!");
  const aToken = aLogin.body.accessToken;
  const bToken = (await login("b@x.test", "Password123!")).body.accessToken;

  console.log("register / buyer tenancy");
  const reg = await call("POST", "/api/v1/auth/register", {
    body: { name: "Buyer One", email: "buyer1@x.test", password: "Password123!", tenantSlug: "store-a", tenantId: tenantB },
  });
  check("register 201 generic", reg.status === 201 && !reg.body.id, reg.body);
  const dup = await call("POST", "/api/v1/auth/register", { body: { name: "Other", email: "buyer1@x.test", password: "Password999!" } });
  check("duplicate register indistinguishable", dup.status === 201 && dup.body.message === reg.body.message, dup.body);
  const buyerDoc = await User.findOne({ email: "buyer1@x.test" });
  check("buyer tenantId null, homeTenantId = store-a", buyerDoc.tenantId === null && String(buyerDoc.homeTenantId) === tenantA);
  check("buyer email unverified", buyerDoc.emailVerified === false);
  const bl = await login("buyer1@x.test", "Password123!");
  check("buyer login, no refreshToken in JSON for web", bl.status === 200 && !bl.body.refreshToken && bl.body.accessToken, bl.body);
  const bc = refreshCookie(bl);
  check("refresh cookie set with Max-Age from JWT_REFRESH_TTL", bc && /Max-Age=604800/.test(bc.raw), bc?.raw);
  const buyerToken = bl.body.accessToken;
  check("me exposes emailVerified", (await call("GET", "/api/v1/auth/me", { token: buyerToken })).body.emailVerified === false);
  const buyersUsers = await call("GET", "/api/v1/users", { token: buyerToken });
  check("buyer blocked from staff route /users", buyersUsers.status === 403, buyersUsers.body);
  const buyerTenantPatch = await call("PATCH", "/api/v1/tenants/me", { token: buyerToken, body: { taxSettings: { defaultTaxRate: 0 } } });
  check("buyer cannot PATCH /tenants/me", buyerTenantPatch.status === 403, buyerTenantPatch.body);
  const buyerTenant = await call("GET", "/api/v1/tenants/me", { token: buyerToken });
  check("buyer GET /tenants/me = public home store", buyerTenant.status === 200 && buyerTenant.body.slug === "store-a" && !buyerTenant.body.businessProfile, buyerTenant.body);
  const mob = await login("buyer1@x.test", "Password123!", { "X-Client": "mobile" });
  check("mobile login returns refreshToken", Boolean(mob.body.refreshToken));

  console.log("email verification");
  await User.updateOne({ _id: buyerDoc._id }, { $set: { emailVerifyTokenHash: hashToken("known-verify-token-123"), emailVerifyExpires: new Date(Date.now() + 60000) } });
  const ver = await call("POST", "/api/v1/auth/verify-email", { body: { token: "known-verify-token-123" } });
  check("verify email", ver.status === 200 && (await User.findById(buyerDoc._id)).emailVerified === true, ver.body);
  const ver2 = await call("POST", "/api/v1/auth/verify-email", { body: { token: "known-verify-token-123" } });
  check("verify token single-use", ver2.status === 400);

  console.log("refresh rotation / reuse");
  const r1 = await call("POST", "/api/v1/auth/refresh", { cookie: bc.cookie });
  const c1 = refreshCookie(r1);
  check("refresh ok, rotated cookie", r1.status === 200 && c1 && c1.token !== bc.token && !r1.body.refreshToken, r1.body);
  const race = await call("POST", "/api/v1/auth/refresh", { cookie: bc.cookie });
  check("previous token within grace -> REFRESH_RACE (no revoke)", race.status === 401 && race.body.code === "REFRESH_RACE", race.body);
  const r2 = await call("POST", "/api/v1/auth/refresh", { cookie: c1.cookie });
  const c2 = refreshCookie(r2);
  check("second rotation ok", r2.status === 200 && c2);
  const reuse = await call("POST", "/api/v1/auth/refresh", { cookie: bc.cookie });
  check("old token reuse detected", reuse.status === 401 && reuse.body.code === "TOKEN_REUSE", reuse.body);
  const afterReuse = await call("POST", "/api/v1/auth/refresh", { cookie: c2.cookie });
  check("latest token revoked after reuse", afterReuse.status === 401, afterReuse.body);
  const accessAfterReuse = await call("GET", "/api/v1/auth/me", { token: r2.body.accessToken });
  check("access tokens revoked after reuse", accessAfterReuse.status === 401 && accessAfterReuse.body.code === "TOKEN_REVOKED", accessAfterReuse.body);

  console.log("logout without access token / logout-all");
  const l1 = await login("buyer1@x.test", "Password123!");
  const lc = refreshCookie(l1);
  const lo = await call("POST", "/api/v1/auth/logout", { cookie: lc.cookie });
  check("logout without access token ok", lo.status === 200);
  const afterLogout = await call("POST", "/api/v1/auth/refresh", { cookie: lc.cookie });
  check("refresh after logout fails", afterLogout.status === 401);
  const l2 = await login("buyer1@x.test", "Password123!");
  const la = await call("POST", "/api/v1/auth/logout-all", { token: l2.body.accessToken });
  check("logout-all ok", la.status === 200);
  check("access token dead after logout-all", (await call("GET", "/api/v1/auth/me", { token: l2.body.accessToken })).status === 401);

  console.log("lockout");
  const victim = await login("buyer1@x.test", "Password123!");
  for (let i = 0; i < 5; i += 1) await login("buyer1@x.test", "wrong-password");
  const locked = await login("buyer1@x.test", "Password123!");
  check("correct password during delay -> 429 LOGIN_DELAYED", locked.status === 429 && locked.body.code === "LOGIN_DELAYED", locked.body);
  const vdoc = await User.findOne({ email: "buyer1@x.test" });
  check("status not flipped to locked", vdoc.status === "active", vdoc.status);
  check("existing session survives lockout", (await call("GET", "/api/v1/auth/me", { token: victim.body.accessToken })).status === 200);
  const unknown = await login("nobody@x.test", "whatever");
  check("unknown email -> generic 401", unknown.status === 401 && unknown.body.message === "Invalid credentials");
  await User.updateOne({ _id: vdoc._id }, { $set: { lockedUntil: null, failedLoginAttempts: 0 } });

  console.log("forgot / reset password");
  const fp = await call("POST", "/api/v1/auth/forgot-password", { body: { email: "buyer1@x.test" } });
  check("forgot-password never returns token", fp.status === 200 && !fp.body.token, fp.body);
  const fpUnknown = await call("POST", "/api/v1/auth/forgot-password", { body: { email: "zzz@x.test" } });
  check("forgot-password generic for unknown", fpUnknown.body.message === fp.body.message);
  const preReset = await login("buyer1@x.test", "Password123!");
  await User.updateOne({ _id: vdoc._id }, { $set: { passwordResetTokenHash: hashToken("known-reset-token-123"), passwordResetExpires: new Date(Date.now() + 60000) } });
  const rp = await call("POST", "/api/v1/auth/reset-password", { body: { token: "known-reset-token-123", password: "NewPassword123!" } });
  check("reset password ok", rp.status === 200, rp.body);
  check("reset kills old access token", (await call("GET", "/api/v1/auth/me", { token: preReset.body.accessToken })).status === 401);

  console.log("change password");
  const cp0 = await login("buyer1@x.test", "NewPassword123!");
  const cp = await call("POST", "/api/v1/auth/change-password", { token: cp0.body.accessToken, body: { currentPassword: "NewPassword123!", newPassword: "Password123!" } });
  check("change password returns fresh token", cp.status === 200 && cp.body.accessToken, cp.body);
  check("old token revoked", (await call("GET", "/api/v1/auth/me", { token: cp0.body.accessToken })).status === 401);
  check("new token works", (await call("GET", "/api/v1/auth/me", { token: cp.body.accessToken })).status === 200);

  console.log("RBAC escalation");
  const star = await call("POST", "/api/v1/roles", { token: aToken, body: { name: "Root", permissions: ["*"] } });
  check("tenant admin cannot create role with *", star.status === 403, star.body);
  const tenantsPerm = await call("POST", "/api/v1/roles", { token: aToken, body: { name: "Tenants role", permissions: ["tenants.edit"] } });
  check("tenant admin cannot grant tenants.*", tenantsPerm.status === 403, tenantsPerm.body);
  const limited = await call("POST", "/api/v1/roles", { token: aToken, body: { name: "Role Manager", permissions: ["roles.view", "roles.create", "roles.edit", "users.view", "users.create", "users.edit"] } });
  check("tenant admin creates subset role", limited.status === 201, limited.body);
  const bRole = await call("POST", "/api/v1/roles", { token: bToken, body: { name: "B Role", permissions: ["orders.view"] } });
  const mgr = await call("POST", "/api/v1/users", { token: aToken, body: { name: "Mgr", email: "mgr@x.test", password: "Password123!", roleId: limited.body._id } });
  check("tenant admin creates manager", mgr.status === 201, mgr.body);
  const mgrToken = (await login("mgr@x.test", "Password123!")).body.accessToken;
  const esc = await call("POST", "/api/v1/roles", { token: mgrToken, body: { name: "Esc", permissions: ["orders.refund"] } });
  check("manager cannot grant perms they lack", esc.status === 403, esc.body);
  const selfEdit = await call("PATCH", `/api/v1/roles/${limited.body._id}`, { token: mgrToken, body: { permissions: ["roles.view", "roles.create", "roles.edit", "users.view", "users.create", "users.edit", "orders.refund"] } });
  check("manager cannot add perms to own role", selfEdit.status === 403, selfEdit.body);
  const asAdmin = await call("POST", "/api/v1/users", { token: mgrToken, body: { name: "Xavier", email: "x1@x.test", password: "Password123!", roleId: String(roles.tenant_admin._id) } });
  check("manager cannot assign tenant_admin (exceeds own perms)", asAdmin.status === 403, asAdmin.body);
  const asSuper = await call("POST", "/api/v1/users", { token: aToken, body: { name: "Xavier", email: "x2@x.test", password: "Password123!", roleId: String(roles.super_admin._id) } });
  check("tenant admin cannot assign super_admin", asSuper.status === 403, asSuper.body);
  const crossRole = await call("POST", "/api/v1/users", { token: aToken, body: { name: "Xavier", email: "x3@x.test", password: "Password123!", roleId: bRole.body._id } });
  check("cannot assign another tenant's role", crossRole.status === 403, crossRole.body);
  const delHeld = await call("DELETE", `/api/v1/roles/${limited.body._id}`, { token: aToken });
  check("cannot delete role while held", delHeld.status === 409, delHeld.body);
  const mass = await call("PATCH", `/api/v1/users/${mgr.body.id}`, { token: aToken, body: { name: "Mgr2", tenantId: tenantB, status: "locked" } });
  check("user PATCH rejects system statuses", mass.status === 400, mass.body);
  const mass2 = await call("PATCH", `/api/v1/users/${mgr.body.id}`, { token: aToken, body: { name: "Mgr2", tenantId: tenantB } });
  check("user PATCH strips tenantId", mass2.status === 200 && String((await User.findById(mgr.body.id)).tenantId) === tenantA, mass2.body);
  const demote = await call("PATCH", `/api/v1/users/${mgr.body.id}`, { token: aToken, body: { status: "suspended" } });
  check("suspend user ok", demote.status === 200);
  check("suspended user's token rejected", [401, 403].includes((await call("GET", "/api/v1/auth/me", { token: mgrToken })).status));
  // Legacy malicious role stored with "*": must not make the holder a platform admin.
  const evilRole = await Role.create({ name: "Evil", slug: "evil", tenantId: tenantA, permissions: ["*", "tenants.edit"], scope: "tenant" });
  await User.create({ name: "Evil", email: "evil@x.test", passwordHash: (await User.findOne({ email: "a@x.test" }).select("+passwordHash")).passwordHash, tenantId: tenantA, roleId: evilRole._id, status: "active", emailVerified: true });
  const evilToken = (await login("evil@x.test", "Password123!")).body.accessToken;
  const evilTenants = await call("GET", "/api/v1/tenants", { token: evilToken });
  check("stored '*' on tenant role grants nothing platform-wide", evilTenants.status === 403, evilTenants.body);
  const evilPatchB = await call("PATCH", `/api/v1/tenants/${tenantB}`, { token: evilToken, body: { name: "pwned" } });
  check("stored tenants.edit on tenant role is stripped", evilPatchB.status === 403, evilPatchB.body);
  const rolesList = await call("GET", "/api/v1/roles?limit=2", { token: aToken });
  check("roles list paginated", rolesList.status === 200 && Array.isArray(rolesList.body.data) && rolesList.body.meta?.limit === 2, rolesList.body);
  const noBody = await fetch(base + "/api/v1/users", { method: "POST", headers: { Authorization: `Bearer ${aToken}`, "X-Forwarded-For": "10.9.9.9" } });
  check("missing body -> 400 not 500", noBody.status === 400);

  console.log("tenant profile + suspension");
  const tp = await call("PATCH", "/api/v1/tenants/me", { token: aToken, body: { branding: { secondaryColor: "#222222" }, status: "active", slug: "hijack" } });
  check("tenant admin PATCH /tenants/me ok", tp.status === 200, tp.body);
  const tdoc = await Tenant.findById(tenantA);
  check("nested merge kept primaryColor; slug untouched", tdoc.branding.primaryColor === "#111111" && tdoc.branding.secondaryColor === "#222222" && tdoc.slug === "store-a", tdoc.branding);
  const aCookie = refreshCookie(aLogin);
  const susp = await call("PATCH", `/api/v1/tenants/${tenantA}`, { token: adminToken, body: { status: "suspended" } });
  check("platform admin suspends tenant", susp.status === 200);
  const aMe = await call("GET", "/api/v1/auth/me", { token: aToken });
  check("suspended tenant staff rejected", aMe.status === 403 && aMe.body.code === "TENANT_SUSPENDED", aMe.body);
  const aRef = await call("POST", "/api/v1/auth/refresh", { cookie: aCookie.cookie });
  check("suspended tenant staff cannot refresh", aRef.status === 403, aRef.body);
  const aLogin2 = await login("a@x.test", "Password123!");
  check("suspended tenant staff cannot login", aLogin2.status === 403, aLogin2.body);
  const buyerStill = await login("buyer1@x.test", "Password123!");
  check("buyer of suspended home store can still log in", buyerStill.status === 200);
  await call("PATCH", `/api/v1/tenants/${tenantA}`, { token: adminToken, body: { status: "active" } });

  console.log("export / delete account");
  const exp = await call("GET", "/api/v1/auth/me/export", { token: buyerStill.body.accessToken });
  check("export", exp.status === 200 && exp.body.profile?.email === "buyer1@x.test" && Array.isArray(exp.body.orders), exp.body);
  const delWrong = await call("DELETE", "/api/v1/auth/me", { token: buyerStill.body.accessToken, body: { password: "nope" } });
  check("delete needs password", delWrong.status === 400);
  const staffDel = await call("DELETE", "/api/v1/auth/me", { token: bToken, body: { password: "Password123!" } });
  check("staff cannot self-delete", staffDel.status === 403);
  const del = await call("DELETE", "/api/v1/auth/me", { token: buyerStill.body.accessToken, body: { password: "Password123!" } });
  const ddoc = await User.findById(vdoc._id);
  check("buyer self-delete anonymises", del.status === 200 && ddoc.status === "deleted" && ddoc.email.endsWith("@deleted.invalid") && ddoc.name === "Deleted user", ddoc);
  check("deleted user's login fails", (await login("buyer1@x.test", "Password123!")).status === 401);

  console.log("uploads");
  const html = Buffer.from("<html><script>fetch('/api/v1/auth/refresh')</script></html>");
  let rejected = false;
  try {
    await storage.save({ buffer: html, originalName: "evil.png", mimeType: "image/png", folder: "../../src" });
  } catch (err) {
    rejected = err.code === "FILE_TYPE";
  }
  check("html disguised as png rejected", rejected);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const saved = await storage.save({ buffer: png, originalName: "x.html", mimeType: "text/html", folder: "../../src" });
  check("real png saved, ext from sniffed type, folder whitelisted", saved.mimeType === "image/png" && saved.key.startsWith("general/") && saved.key.endsWith(".png"), saved);
  const served = await fetch(`${base}${saved.url}`);
  check(
    "served with nosniff + sandbox CSP + inline",
    served.status === 200 && served.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(served.headers.get("content-security-policy") || "") && served.headers.get("content-disposition") === "inline"
  );
  await fs.writeFile(path.join(uploadRoot, "general", "legacy.html"), "<script>1</script>");
  check("legacy .html in uploads not served", (await fetch(`${base}/uploads/general/legacy.html`)).status === 404);
  await storage.remove(saved.key);
  await fs.unlink(path.join(uploadRoot, "general", "legacy.html")).catch(() => {});

  console.log("cron / health / cors");
  const prevSecret = env.cronSecret;
  env.cronSecret = "";
  check("cron without CRON_SECRET configured -> 503", (await call("POST", "/api/internal/cron/cleanup")).status === 503);
  env.cronSecret = "test-cron-secret-0123456789";
  check("cron without auth -> 401", (await call("POST", "/api/internal/cron/cleanup")).status === 401);
  check("cron wrong secret -> 401", (await call("GET", "/api/internal/cron/cleanup", { headers: { Authorization: "Bearer nope" } })).status === 401);
  const cronOk = await call("GET", "/api/internal/cron/__unknown__", { headers: { Authorization: "Bearer test-cron-secret-0123456789" } });
  check("cron with secret passes auth (404 unknown job / 501 / 500 if jobs module mid-edit)", cronOk.status !== 401 && cronOk.status !== 503, cronOk);
  env.cronSecret = prevSecret;
  check("health 200", (await call("GET", "/api/health")).status === 200);
  check("ready 200 when connected", (await call("GET", "/api/ready")).status === 200);
  check("CORS: exact origin ok", isOriginAllowed("https://msp-react.vercel.app"));
  check("CORS: other vercel app rejected", !isOriginAllowed("https://evil.vercel.app"));

  console.log("migrations");
  const legacyBuyer = await User.create({ name: "Legacy", email: "legacy@x.test", passwordHash: "x", tenantId: tenantB, roleId: roles.buyer._id, status: "locked" });
  await User.collection.updateOne({ _id: legacyBuyer._id }, { $unset: { emailVerified: "" } });
  await runAuthMigrations();
  const lb = await User.findById(legacyBuyer._id);
  check("migration: buyer tenantId -> homeTenantId, locked -> active, grandfather verified", lb.tenantId === null && String(lb.homeTenantId) === tenantB && lb.status === "active" && lb.emailVerified === true, lb);

  server.close();
  await mongoose.disconnect();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
