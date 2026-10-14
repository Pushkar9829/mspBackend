import bcrypt from "bcryptjs";
import { Tenant } from "./tenant.model.js";
import { User } from "../users/user.model.js";
import { Role } from "../rbac/role.model.js";
import { AppError } from "../../utils/AppError.js";
import { slugify } from "../../utils/slug.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { SYSTEM_ROLES, FULFILLMENT_MODES, TENANT_STATUSES, SELLING_TENANT_STATUSES } from "../../config/constants.js";
import { Product } from "../catalog/product.model.js";
import { Settings } from "../settings/settings.model.js";
import { SALT } from "../auth/service.js";
import { emitDomain } from "../../utils/events.js";
import { geocodeAddress } from "../location/service.js";
import { normalizeIndianState } from "../location/pincode.js";
import { normalizeGstin } from "../../utils/gstin.js";
import { afterCommit, withSession } from "../../utils/transaction.js";
import { bumpCatalogVersion } from "../search/catalogVersion.js";
import { AdminAccessLog } from "./adminAccessLog.model.js";
import { PrivateFile } from "../files/privateFile.model.js";
import { loadUserRefs, userRef } from "../../utils/userRefs.js";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NESTED = ["branding", "businessProfile", "taxSettings", "orderRules", "notificationPreferences", "pickupAddress", "kyc"];

/** Statuses an admin "approves" a store into (from pending). */
const APPROVED_STATUSES = ["active"];

/** Seller identity is locked once both legal name and GSTIN are on file. */
export function identityLocked(tenant) {
  const bp = tenant?.businessProfile || {};
  return Boolean(String(bp.legalName || "").trim() && String(bp.gstin || "").trim());
}

/** KYC incomplete: no legal name or no checksum-valid GSTIN (existing stores keep working). */
export function kycIncomplete(tenant) {
  const bp = tenant?.businessProfile || {};
  return !String(bp.legalName || "").trim() || !normalizeGstin(bp.gstin);
}

/** API shape of a tenant (plain object) with the identity / KYC flags. */
export function presentTenant(tenant) {
  if (!tenant) return tenant;
  const plain = typeof tenant.toObject === "function" ? tenant.toObject() : { ...tenant };
  // Never return the (encrypted) bank account number; last4 / accountRef are enough for every UI.
  if (plain.kyc?.bank) {
    const { accountNumberEnc, accountHash, ...bank } = plain.kyc.bank;
    plain.kyc = { ...plain.kyc, bank: { ...bank, hasAccountNumber: Boolean(accountNumberEnc || bank.accountRef) } };
  }
  return {
    ...plain,
    kycIncomplete: kycIncomplete(plain),
    identityLocked: identityLocked(plain),
    fssaiExpired: fssaiExpired(plain),
  };
}

const KYC_LINK_TTL_SECONDS = 5 * 60;

/** Signed 5-minute download links for the store's KYC documents (+ FSSAI licence file). */
async function kycDocumentsWithLinks(kyc) {
  const docs = kyc?.documents || [];
  const fssaiFileId = kyc?.fssai?.fileId || null;
  const ids = [...docs.map((d) => d.fileId), fssaiFileId].filter(Boolean);
  if (!ids.length) return { documents: docs, fssaiFile: null };
  const { signPrivateFile } = await import("../files/routes.js");
  const files = await PrivateFile.find({ _id: { $in: ids } }).lean();
  const byId = new Map(files.map((f) => [String(f._id), f]));
  const link = (fileId) => {
    const f = byId.get(String(fileId));
    if (!f) return { fileId, missing: true };
    const exp = Math.floor(Date.now() / 1000) + KYC_LINK_TTL_SECONDS;
    return {
      fileId,
      originalName: f.originalName || "",
      mimeType: f.mimeType || "",
      size: f.size || 0,
      url: `/api/v1/files/private/${f._id}?exp=${exp}&sig=${signPrivateFile(String(f._id), String(exp))}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  };
  return {
    documents: docs.map((d) => ({ type: d.type, ...link(d.fileId) })),
    fssaiFile: fssaiFileId ? link(fssaiFileId) : null,
  };
}

/**
 * Platform-admin API shape: presentTenant + `statusHistory[].by` resolved to { id, name, email }.
 * `withDocs` (detail) adds signed links to `kyc.documents[]` and `kyc.fssaiFile`.
 * `users`: optional prefetched map (loadUserRefs) for lists.
 */
export async function presentTenantForAdmin(tenant, { withDocs = false, users = null } = {}) {
  if (!tenant) return tenant;
  const out = presentTenant(tenant);
  const map = users || (await loadUserRefs((out.statusHistory || []).map((h) => h.by)));
  out.statusHistory = (out.statusHistory || []).map((h) => ({ ...h, by: userRef(h.by, map) }));
  if (withDocs && out.kyc) {
    const { documents, fssaiFile } = await kycDocumentsWithLinks(out.kyc);
    out.kyc = { ...out.kyc, documents, fssaiFile };
  }
  return out;
}

/** True when the store has an FSSAI licence on file whose expiry date has passed. */
export function fssaiExpired(tenant, now = new Date()) {
  const at = tenant?.kyc?.fssai?.expiresAt;
  return Boolean(tenant?.kyc?.fssai?.number && at && new Date(at).getTime() <= now.getTime());
}

/* ------------------------------------------------------------------ status changes */

/** Domain event per transition (null = none). */
function statusEvent(from, to) {
  if (to === "active") {
    if (from === "pending") return "TENANT_APPROVED";
    if (from === "paused") return "TENANT_RESUMED";
    if (from === "suspended" || from === "archived") return "TENANT_REACTIVATED";
    return null;
  }
  if (to === "paused") return "TENANT_PAUSED";
  if (to === "suspended") return "TENANT_SUSPENDED";
  if (to === "archived") return "TENANT_ARCHIVED";
  return null;
}

/** Drop storefront caches after a status change (visibility, search dictionary). */
async function afterStatusChange(tenantId, to) {
  try {
    const catalog = await import("../catalog/service.js");
    if (typeof catalog.invalidateActiveTenants === "function") catalog.invalidateActiveTenants();
  } catch {
    /* catalog cache is optional */
  }
  bumpCatalogVersion();
  if (to === "archived") {
    // TENANT_SUSPENDED drops staff sockets via sockets/index.js; archive does it here.
    try {
      const sockets = await import("../../sockets/index.js");
      sockets.disconnectTenantSockets?.(String(tenantId));
    } catch {
      /* sockets optional (tests / serverless) */
    }
  }
}

/**
 * The ONLY way to change a store's operational status. Records `statusHistory` (long-term),
 * `statusReason` / `statusChangedAt`, invalidates storefront caches, and emits (after commit when a
 * session is given) TENANT_APPROVED | TENANT_PAUSED | TENANT_RESUMED | TENANT_SUSPENDED |
 * TENANT_REACTIVATED | TENANT_ARCHIVED with { tenantId, from, to, status, reason, by, source? }.
 * `source: "billing"` (subscription billing) suppresses the generic paused/resumed seller notice.
 * A reason is required for every change except to `active`. Same status = no-op.
 * Conditional on the status read (409 CONFLICT if it changed concurrently).
 */
export async function setTenantStatus(tenantId, to, { reason = "", by = null, session = null, source = "" } = {}) {
  if (!TENANT_STATUSES.includes(to)) {
    throw new AppError(400, "Invalid store status", "VALIDATION_ERROR", { fields: { status: "Invalid status" } });
  }
  const why = String(reason || "").trim().slice(0, 1000);
  const current = await Tenant.findById(tenantId, null, withSession(session));
  if (!current) throw new AppError(404, "Tenant not found", "NOT_FOUND");
  const from = current.status;
  if (from === to) return current;
  if (to !== "active" && why.length < 3) {
    throw new AppError(400, "A reason is required for this status change", "REASON_REQUIRED", {
      fields: { reason: "Required (at least 3 characters)" },
    });
  }
  const at = new Date();
  const byId = by?._id || by || null;
  const tenant = await Tenant.findOneAndUpdate(
    { _id: current._id, status: from },
    {
      $set: { status: to, statusReason: to === "active" ? "" : why, statusChangedAt: at },
      $push: { statusHistory: { from, to, reason: why, by: byId, at } },
    },
    withSession(session, { new: true })
  );
  if (!tenant) throw new AppError(409, "The store status changed meanwhile. Reload and try again.", "CONFLICT");
  const event = statusEvent(from, to);
  afterCommit(session, async () => {
    await afterStatusChange(tenant._id, to);
    if (event) {
      emitDomain(event, { tenantId: tenant._id, resource: "tenant", resourceId: tenant._id, from, to, status: to, reason: why, by: byId, ...(source ? { source } : {}) });
    }
  });
  return tenant;
}

async function uniqueTenantSlug(base, session) {
  const root = slugify(base) || "store";
  let slug = root;
  for (let n = 2; await Tenant.exists({ slug }).session(session || null); n += 1) slug = `${root}-${n}`;
  return slug;
}

const last4 = (v) => String(v || "").replace(/\s+/g, "").slice(-4);

/**
 * Approve a SellerApplication into a live store (called by the seller-applications module).
 * Creates the tenant (status active, KYC copied + verified, identity locked via legal name +
 * GSTIN), records statusHistory / termsAcceptance / applicationId, moves the applicant user into
 * the store as tenant_admin, emits TENANT_APPROVED (after commit). Idempotent per application:
 * a second call returns the tenant already created for it.
 * The full bank account number is never copied: `kyc.bank.accountNumberEnc` only when the
 * application holds an encrypted value, otherwise `accountRef = "sellerApplication:<id>"`.
 */
export async function createTenantFromApplication(application, { by = null, session = null } = {}) {
  if (!application?._id) throw new AppError(400, "Application required", "VALIDATION_ERROR");
  const existing = await Tenant.findOne({ applicationId: application._id }, null, withSession(session));
  if (existing) return existing;
  const biz = application.business || {};
  const gstin = normalizeGstin(biz.gstin);
  if (!gstin) throw gstinRequired();
  const adminRole = await Role.findOne({ slug: SYSTEM_ROLES.TENANT_ADMIN, isSystem: true }, null, withSession(session));
  if (!adminRole) throw new AppError(500, "Tenant admin role not seeded", "SERVER_ERROR");
  const user = application.userId ? await User.findById(application.userId, null, withSession(session)) : null;
  if (!user) throw new AppError(404, "Applicant account not found", "NOT_FOUND");
  if (user.tenantId) throw new AppError(409, "The applicant already belongs to a store", "CONFLICT");

  const name = String(biz.tradeName || biz.legalName || "").trim() || "Store";
  const slug = await uniqueTenantSlug(name, session);
  const at = new Date();
  const byId = by?._id || by || null;
  const docs = (application.documents || []).filter((d) => d?.fileId).map((d) => ({ type: d.type, fileId: d.fileId }));
  const bank = application.bank || {};
  const fssai = application.fssai?.number
    ? {
        number: String(application.fssai.number).trim(),
        expiresAt: application.fssai.expiresAt || null,
        fileId: application.fssai.fileId || docs.find((d) => d.type === "fssai")?.fileId || null,
      }
    : null;
  const reg = application.registeredAddress || {};
  const pickup = application.pickupAddress || {};
  const [tenant] = await Tenant.create(
    [
      {
        name,
        slug,
        status: "active",
        statusChangedAt: at,
        statusHistory: [{ from: "pending", to: "active", reason: "Seller application approved", by: byId, at }],
        applicationId: application._id,
        businessProfile: {
          legalName: biz.legalName || name,
          gstin,
          email: application.email || user.email || "",
          phone: application.phone || user.phone || "",
        },
        pickupAddress: await withGeocodedPickup({
          contactName: pickup.contactName || pickup.name || "",
          phone: pickup.phone || application.phone || "",
          addressLine1: [pickup.addressLine1, pickup.addressLine2].filter(Boolean).join(", "),
          city: pickup.city || "",
          state: pickup.state || "",
          postalCode: pickup.postalCode || "",
          country: pickup.country || "IN",
        }),
        kyc: {
          pan: String(biz.pan || "").toUpperCase(),
          gstin,
          legalName: biz.legalName || "",
          tradeName: biz.tradeName || "",
          businessType: biz.businessType || "",
          registeredAddress: {
            addressLine1: reg.addressLine1 || "",
            addressLine2: reg.addressLine2 || "",
            city: reg.city || "",
            state: reg.state ? normalizeIndianState(reg.state).state : "",
            postalCode: reg.postalCode || "",
            country: reg.country || "IN",
          },
          bank: {
            holderName: bank.holderName || "",
            accountLast4: bank.accountLast4 || last4(bank.accountNumber),
            accountNumberEnc: bank.accountNumberEnc || "",
            accountRef: bank.accountNumberEnc ? "" : `sellerApplication:${application._id}`,
            accountHash: bank.accountHash || "",
            ifsc: String(bank.ifsc || "").toUpperCase(),
            verified: Boolean(bank.verified),
          },
          fssai,
          documents: docs,
          sellsFood: Boolean(application.sellsFood),
          categories: application.categories || [],
          verifiedAt: at,
          verifiedBy: byId,
        },
        termsAcceptance: application.termsVersion
          ? [{ version: String(application.termsVersion), acceptedAt: application.termsAcceptedAt || at, userId: user._id, ip: application.termsAcceptedIp || application.termsIp || "" }]
          : [],
      },
    ],
    withSession(session)
  );
  await User.updateOne(
    { _id: user._id },
    { $set: { tenantId: tenant._id, roleId: adminRole._id, status: "active" } },
    withSession(session)
  );
  // KYC files were uploaded by the applicant before the store existed (tenantId null): attach them
  // to the new store so its staff can open them too (platform admins can open any private file).
  const kycFileIds = [...docs.map((d) => d.fileId), fssai?.fileId].filter(Boolean);
  if (kycFileIds.length) {
    await PrivateFile.updateMany(
      { _id: { $in: kycFileIds }, tenantId: null, uploadedBy: user._id },
      { $set: { tenantId: tenant._id } },
      withSession(session)
    );
  }
  afterCommit(session, async () => {
    await afterStatusChange(tenant._id, "active");
    emitDomain("TENANT_APPROVED", {
      tenantId: tenant._id,
      resource: "tenant",
      resourceId: tenant._id,
      from: "pending",
      to: "active",
      status: "active",
      applicationId: application._id,
      userId: user._id,
      by: byId,
    });
    // Seller payouts (p4-payouts): Razorpay Route linked account when payouts.mode = route (best effort).
    const { autoCreateLinkedAccount } = await import("../payouts/route.js");
    await autoCreateLinkedAccount(tenant._id);
  });
  // Phase 3 billing: subscription (awaiting_payment) + first invoice; the store is paused until it
  // is paid. No-op when no paid plan exists (billing not set up).
  const { onTenantApproved } = await import("../billing/service.js");
  const paused = await onTenantApproved(tenant, application, { by: byId, session });
  return paused || tenant;
}

function gstinRequired() {
  return new AppError(400, "A valid GSTIN is required to create or approve a store", "GSTIN_REQUIRED", {
    fields: { "businessProfile.gstin": "A valid GSTIN is required" },
  });
}

const TENANT_SORT_FIELDS = { createdAt: "createdAt", updatedAt: "updatedAt", name: "name", slug: "slug", status: "status" };

/**
 * Platform tenant list. q (name/slug/legal name/email/GSTIN/zone), status (comma list),
 * sort (createdAt|updatedAt|name|slug|status) + order (asc|desc). Each row carries `staffCount`
 * (members with tenantId = store, not deleted). Per-tenant sales stats come from /reports/tenants.
 */
export async function listTenants(query) {
  const { page, limit, skip } = paginate(query);
  const filter = {};
  if (query.status) {
    const statuses = String(query.status).split(",").map((v) => v.trim()).filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  if (query.q) {
    const rx = new RegExp(escapeRegex(String(query.q).trim().slice(0, 100)), "i");
    filter.$or = [
      { name: rx },
      { slug: rx },
      { "businessProfile.legalName": rx },
      { "businessProfile.email": rx },
      { "businessProfile.gstin": rx },
      { "deliveryZones.name": rx },
    ];
  }
  const field = TENANT_SORT_FIELDS[String(query.sort || "")] || "createdAt";
  const dir = String(query.order || "").toLowerCase() === "asc" ? 1 : -1;
  const [rows, total] = await Promise.all([
    Tenant.find(filter)
      .collation({ locale: "en", strength: 2 })
      .sort({ [field]: dir, _id: dir })
      .skip(skip)
      .limit(limit)
      .lean(),
    Tenant.countDocuments(filter),
  ]);
  const counts = rows.length
    ? await User.aggregate([
        { $match: { tenantId: { $in: rows.map((t) => t._id) }, status: { $ne: "deleted" } } },
        { $group: { _id: "$tenantId", n: { $sum: 1 } } },
      ])
    : [];
  const byTenant = new Map(counts.map((c) => [String(c._id), c.n]));
  const users = await loadUserRefs(rows.flatMap((t) => (t.statusHistory || []).map((h) => h.by)));
  const data = await Promise.all(
    rows.map(async (t) => ({ ...(await presentTenantForAdmin(t, { users })), id: t._id, staffCount: byTenant.get(String(t._id)) || 0 }))
  );
  return paginated(data, total, { page, limit });
}

export async function getTenant(id) {
  const tenant = await Tenant.findById(id);
  if (!tenant) throw new AppError(404, "Tenant not found", "NOT_FOUND");
  return tenant;
}

async function withGeocodedPickup(input) {
  if (!input) return undefined;
  // Store the canonical state name ("DL" / "New Delhi" -> "Delhi") so GST place-of-supply
  // comparisons on invoices see the same spelling as buyer addresses.
  const address = input.state !== undefined ? { ...input, state: normalizeIndianState(input.state).state } : input;
  const hasPlace = address.addressLine1 || address.city || address.postalCode;
  if (!hasPlace) return address;
  const geo = await geocodeAddress(address);
  return {
    ...address,
    latitude: geo.latitude,
    longitude: geo.longitude,
    placeId: geo.placeId || "",
    formatted: geo.formatted || "",
  };
}

export async function createTenant(body, opts = {}) {
  const slug = slugify(body.slug || body.name);
  if (!slug) throw new AppError(400, "Invalid slug", "VALIDATION_ERROR");
  // New stores must carry a checksum-valid GSTIN (validators normalise it; re-checked here).
  if (!normalizeGstin(body.businessProfile?.gstin)) throw gstinRequired();
  const exists = await Tenant.findOne({ slug });
  if (exists) throw new AppError(409, "Slug already in use", "DUPLICATE");

  let adminRole = null;
  if (body.admin) {
    adminRole = await Role.findOne({ slug: SYSTEM_ROLES.TENANT_ADMIN, isSystem: true });
    if (!adminRole) throw new AppError(500, "Tenant admin role not seeded", "SERVER_ERROR");
    const existing = await User.findOne({ email: body.admin.email.toLowerCase() }).select("_id");
    if (existing) throw new AppError(409, "Admin email already registered", "DUPLICATE");
  }

  const tenant = await Tenant.create({
    name: body.name,
    slug,
    status: body.status || "pending",
    statusChangedAt: new Date(),
    statusHistory: [{ from: null, to: body.status || "pending", reason: "Store created by platform admin", by: opts.by || null, at: new Date() }],
    branding: body.branding,
    businessProfile: body.businessProfile,
    taxSettings: body.taxSettings,
    orderRules: body.orderRules,
    deliveryZones: body.deliveryZones || [],
    pickupAddress: await withGeocodedPickup(body.pickupAddress),
    notificationPreferences: body.notificationPreferences,
  });

  if (body.admin) {
    try {
      await User.create({
        name: body.admin.name,
        email: body.admin.email.toLowerCase(),
        passwordHash: await bcrypt.hash(body.admin.password, SALT),
        tenantId: tenant._id,
        roleId: adminRole._id,
        status: "active",
        emailVerified: true,
        emailVerifiedAt: new Date(),
      });
    } catch (err) {
      // Don't leave a tenant without its admin behind.
      await Tenant.deleteOne({ _id: tenant._id }).catch(() => {});
      throw err;
    }
  }

  return tenant;
}

/** Build a $set that merges nested objects field-by-field instead of replacing them. */
function toSet(patch) {
  const set = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (NESTED.includes(key) && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined) set[`${key}.${k}`] = v;
      }
    } else {
      set[key] = value;
    }
  }
  return set;
}

/**
 * Platform admin / store profile update. A `status` change is delegated to setTenantStatus
 * (reason required except -> active; `opts.by` recorded). `kyc` (admin only) merges field-wise;
 * `kyc.fssai` replaces the licence as a whole; a renewed licence (expiry in the future) lifts the
 * FSSAI food-product hold and resets the expiry reminders.
 */
export async function updateTenant(id, body, opts = {}) {
  const before = await Tenant.findById(id);
  if (!before) throw new AppError(404, "Tenant not found", "NOT_FOUND");
  const { status: nextStatus, reason, ...rest } = body;
  const patch = { ...rest };
  const statusChange = nextStatus && nextStatus !== before.status ? nextStatus : null;
  if (statusChange && statusChange !== "active" && String(reason || "").trim().length < 3) {
    throw new AppError(400, "A reason is required for this status change", "REASON_REQUIRED", {
      fields: { reason: "Required (at least 3 characters)" },
    });
  }
  if (patch.kyc?.fssai) {
    const f = patch.kyc.fssai;
    patch.kyc = {
      ...patch.kyc,
      fssai: f.number ? { number: String(f.number).trim(), expiresAt: f.expiresAt ? new Date(f.expiresAt) : null, fileId: f.fileId || before.kyc?.fssai?.fileId || null } : null,
    };
  }
  if (patch.kyc?.pan) patch.kyc = { ...patch.kyc, pan: String(patch.kyc.pan).toUpperCase() };
  // QA R4: a GSTIN on file can't be cleared, and once the identity is locked (legal name + GSTIN)
  // both are read-only for everyone. Re-sending the current values (whole-form saves) is fine.
  const beforeBp = before.businessProfile || {};
  const nextGstin = body.businessProfile?.gstin;
  const nextLegal = body.businessProfile?.legalName;
  const gstinChanged = nextGstin !== undefined && String(nextGstin).trim().toUpperCase() !== String(beforeBp.gstin || "").trim().toUpperCase();
  const legalChanged = nextLegal !== undefined && String(nextLegal).trim() !== String(beforeBp.legalName || "").trim();
  // Platform admins may correct a locked identity with a reason (recorded + store notified).
  const identityChangeReason = body.identityChangeReason;
  delete patch.identityChangeReason;
  const identityCorrection =
    identityLocked(before) && (gstinChanged || legalChanged) && opts.platformAdmin === true && String(identityChangeReason || "").trim().length >= 10;
  if (identityLocked(before) && (gstinChanged || legalChanged) && !identityCorrection) {
    const fields = {};
    if (legalChanged) fields["businessProfile.legalName"] = "Locked once legal name and GSTIN are on file";
    if (gstinChanged) fields["businessProfile.gstin"] = "Locked once legal name and GSTIN are on file";
    throw new AppError(
      409,
      opts.platformAdmin
        ? "Legal name and GSTIN are locked. To correct them, give a reason (at least 10 characters); the change is recorded and the store is notified."
        : "Legal name and GSTIN are locked once both are on file (the store's verified identity) and can't be changed.",
      "IDENTITY_LOCKED",
      { fields, ...(opts.platformAdmin ? { reasonRequired: true } : {}) }
    );
  }
  if (nextGstin !== undefined && String(nextGstin).trim() === "" && String(beforeBp.gstin || "").trim()) {
    throw new AppError(400, "GSTIN can't be removed. Enter a valid GSTIN.", "GSTIN_REQUIRED", { fields: { "businessProfile.gstin": "A valid GSTIN is required" } });
  }
  // GSTIN checksum is enforced whenever the value changes (unchanged legacy values may be re-saved).
  if (nextGstin !== undefined && nextGstin !== "") {
    const unchanged = String(nextGstin).trim().toUpperCase() === String(before.businessProfile?.gstin || "").trim().toUpperCase();
    const normalized = normalizeGstin(nextGstin);
    if (!normalized && !unchanged) {
      throw new AppError(400, "Invalid GSTIN (check the 15 characters and check digit)", "VALIDATION_ERROR", {
        fields: { "businessProfile.gstin": "Invalid GSTIN" },
      });
    }
    if (normalized) patch.businessProfile = { ...body.businessProfile, gstin: normalized };
  }
  // Approving a pending store requires a valid GSTIN (stores already live without one keep working).
  if (statusChange && APPROVED_STATUSES.includes(statusChange) && before.status === "pending") {
    const gstin = body.businessProfile?.gstin !== undefined ? body.businessProfile.gstin : before.businessProfile?.gstin;
    if (!normalizeGstin(gstin)) throw gstinRequired();
  }
  if (body.pickupAddress) {
    const merged = { ...(before.pickupAddress?.toObject?.() || {}), ...body.pickupAddress };
    patch.pickupAddress = await withGeocodedPickup(merged);
  }
  const set = toSet(patch);
  const identityPush = identityCorrection
    ? {
        identityChanges: {
          at: new Date(),
          by: opts.by || null,
          reason: String(identityChangeReason).trim(),
          from: { legalName: beforeBp.legalName || "", gstin: beforeBp.gstin || "" },
          to: {
            legalName: legalChanged ? String(nextLegal).trim() : beforeBp.legalName || "",
            gstin: gstinChanged ? normalizeGstin(nextGstin) || String(nextGstin).trim().toUpperCase() : beforeBp.gstin || "",
          },
        },
      }
    : null;
  const fssaiChanged = patch.kyc && Object.prototype.hasOwnProperty.call(patch.kyc, "fssai");
  if (fssaiChanged) set["compliance.fssaiReminders"] = [];
  const update = { ...(Object.keys(set).length ? { $set: set } : {}), ...(identityPush ? { $push: identityPush } : {}) };
  let tenant = Object.keys(update).length ? await Tenant.findByIdAndUpdate(id, update, { new: true, runValidators: true }) : before;
  if (identityPush) {
    emitDomain("TENANT_IDENTITY_CORRECTED", {
      tenantId: tenant._id,
      resource: "tenant",
      resourceId: tenant._id,
      by: opts.by || null,
      reason: identityPush.identityChanges.reason,
      from: identityPush.identityChanges.from,
      to: identityPush.identityChanges.to,
    });
  }
  if (fssaiChanged) {
    const { releaseFssaiHold } = await import("../catalog/compliance.js");
    if (tenant.compliance?.fssaiHoldAt && !fssaiExpired(tenant)) {
      await releaseFssaiHold(tenant._id);
      tenant = await Tenant.findById(id);
      emitDomain("FSSAI_RENEWED", { tenantId: tenant._id, resource: "tenant", resourceId: tenant._id, expiresAt: tenant.kyc?.fssai?.expiresAt || null });
    }
  }
  if (statusChange) tenant = await setTenantStatus(id, statusChange, { reason, by: opts.by || null });
  return tenant;
}

async function storeDisplayName(tenant) {
  try {
    const { getCachedSetting } = await import("../settings/service.js");
    const value = String((await getCachedSetting("tenant", tenant._id, "store.displayName", "")) || "").trim();
    return value || tenant.name;
  } catch {
    return tenant.name;
  }
}

async function publicStorefront(tenant) {
  return {
    _id: tenant._id,
    id: tenant._id,
    name: tenant.name,
    displayName: await storeDisplayName(tenant),
    slug: tenant.slug,
    status: tenant.status,
    branding: tenant.branding,
  };
}

/**
 * Public store info by id or slug (active stores only; + fssai {number}|null): { id, name, displayName, slug,
 * branding, pickupCity, deliveryZones: [{ name, etaDaysMin, etaDaysMax }] }.
 */
export async function getPublicStore(idOrSlug) {
  const key = String(idOrSlug || "").trim();
  const byId = /^[a-f\d]{24}$/i.test(key);
  const tenant = await Tenant.findOne({
    ...(byId ? { _id: key } : { slug: key.toLowerCase() }),
    status: { $in: SELLING_TENANT_STATUSES },
  }).lean();
  if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
  return {
    ...(await publicStorefront(tenant)),
    fssai: publicFssai(tenant),
    pickupCity: tenant.pickupAddress?.city || "",
    deliveryZones: (tenant.deliveryZones || []).map((z) => ({ name: z.name, etaDaysMin: z.etaDaysMin, etaDaysMax: z.etaDaysMax })),
  };
}

const PUBLIC_STORE_STATUSES = SELLING_TENANT_STATUSES;

/** Buyer-facing FSSAI licence ({ number }) of a store that sells food (or has a licence on file), else null. */
export function publicFssai(tenant) {
  const number = String(tenant?.kyc?.fssai?.number || "").trim();
  return number ? { number } : null;
}
const PUBLIC_STORE_SORTS = ["name", "newest", "rating", "products"];
/** In-memory sorts (rating / products) consider at most this many stores. */
const PUBLIC_STORE_CAP = 2000;

/** Published-catalogue stats per store in ONE aggregation: Map(id -> { productCount, rating, ratingCount, deliveryModes }). */
async function storeCatalogStats(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await Product.aggregate([
    { $match: { tenantId: { $in: ids }, status: "published", enabled: { $ne: false } } },
    {
      $group: {
        _id: "$tenantId",
        productCount: { $sum: 1 },
        ratingCount: { $sum: { $ifNull: ["$ratingCount", 0] } },
        ratingSum: { $sum: { $multiply: [{ $ifNull: ["$ratingAvg", 0] }, { $ifNull: ["$ratingCount", 0] }] } },
        modes: { $addToSet: "$deliveryModes" },
      },
    },
  ]);
  for (const row of rows) {
    const modes = new Set((row.modes || []).flat().filter(Boolean));
    if (!modes.size) modes.add("delivery_partner"); // product default
    map.set(String(row._id), {
      productCount: row.productCount,
      rating: row.ratingCount > 0 ? Math.round((row.ratingSum / row.ratingCount) * 10) / 10 : null,
      ratingCount: row.ratingCount,
      deliveryModes: FULFILLMENT_MODES.filter((m) => modes.has(m)),
    });
  }
  return map;
}

/**
 * Public store directory (no auth): active stores only (paused / pending hidden). Query: q (name / slug), city,
 * state, sort=name|newest|rating|products (default name), page, limit (≤ 100).
 * Row: { id, name, displayName, slug, city, state, logo, rating, ratingCount, productCount,
 * deliveryModes, minOrderValue }. `rating` = review-weighted average of the store's published
 * products (null without reviews); `deliveryModes` = union over its published products.
 */
export async function listPublicStores(query = {}) {
  const { page, limit, skip } = paginate(query);
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const text = (v) => String(one(v) ?? "").trim().slice(0, 80);
  const sort = PUBLIC_STORE_SORTS.includes(text(query.sort)) ? text(query.sort) : "name";
  const filter = { status: { $in: PUBLIC_STORE_STATUSES } };
  const q = text(query.q);
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: rx }, { slug: rx }];
  }
  const city = text(query.city);
  if (city) filter["pickupAddress.city"] = new RegExp(`^${escapeRegex(city)}$`, "i");
  const state = text(query.state);
  if (state) filter["pickupAddress.state"] = new RegExp(`^${escapeRegex(state)}$`, "i");

  const fields = "name slug branding.logo pickupAddress.city pickupAddress.state orderRules.minOrderValue createdAt";
  let tenants;
  let total;
  let stats;
  if (sort === "rating" || sort === "products") {
    const all = await Tenant.find(filter).select(fields).sort({ name: 1, _id: 1 }).limit(PUBLIC_STORE_CAP).lean();
    stats = await storeCatalogStats(all.map((t) => t._id));
    const key = (t) => stats.get(String(t._id)) || { productCount: 0, rating: null, ratingCount: 0 };
    all.sort((a, b) =>
      sort === "rating"
        ? (key(b).rating ?? -1) - (key(a).rating ?? -1) || key(b).ratingCount - key(a).ratingCount || a.name.localeCompare(b.name)
        : key(b).productCount - key(a).productCount || a.name.localeCompare(b.name)
    );
    total = all.length;
    tenants = all.slice(skip, skip + limit);
  } else {
    const order = sort === "newest" ? { createdAt: -1, _id: -1 } : { name: 1, _id: 1 };
    [tenants, total] = await Promise.all([
      Tenant.find(filter).select(fields).sort(order).skip(skip).limit(limit).lean(),
      Tenant.countDocuments(filter),
    ]);
    stats = await storeCatalogStats(tenants.map((t) => t._id));
  }
  const names = tenants.length
    ? await Settings.find({ scope: "tenant", tenantId: { $in: tenants.map((t) => t._id) }, key: "store.displayName" }).select("tenantId value").lean()
    : [];
  const nameById = new Map(names.map((row) => [String(row.tenantId), String(row.value || "").trim()]));
  const data = tenants.map((t) => {
    const st = stats.get(String(t._id)) || { productCount: 0, rating: null, ratingCount: 0, deliveryModes: [] };
    return {
      id: t._id,
      name: t.name,
      displayName: nameById.get(String(t._id)) || t.name,
      slug: t.slug,
      city: t.pickupAddress?.city || "",
      state: t.pickupAddress?.state || "",
      logo: t.branding?.logo || "",
      rating: st.rating,
      ratingCount: st.ratingCount,
      productCount: st.productCount,
      deliveryModes: st.deliveryModes,
      minOrderValue: Number(t.orderRules?.minOrderValue) || 0,
    };
  });
  const out = paginated(data, total, { page, limit });
  out.meta.sort = sort;
  return out;
}

/** Staff: their tenant. Buyers: public storefront info of their home tenant (or null). */
export async function getMyTenant(req) {
  const tenantId = req.user?.tenantId?._id || req.user?.tenantId;
  if (tenantId) return getTenant(tenantId);
  if (req.isBuyer && req.user?.homeTenantId) {
    const tenant = await Tenant.findById(req.user.homeTenantId);
    return tenant ? await publicStorefront(tenant) : null;
  }
  throw new AppError(400, "No tenant on this account", "TENANT_REQUIRED");
}

export async function updateMyTenant(req, body) {
  const tenantId = req.user?.tenantId?._id || req.user?.tenantId;
  if (!tenantId || req.isBuyer) throw new AppError(403, "Staff access required", "FORBIDDEN");
  const allowed = {
    name: body.name,
    branding: body.branding,
    businessProfile: body.businessProfile,
    taxSettings: body.taxSettings,
    orderRules: body.orderRules,
    deliveryZones: body.deliveryZones,
    pickupAddress: body.pickupAddress,
    notificationPreferences: body.notificationPreferences,
  };
  const patch = Object.fromEntries(Object.entries(allowed).filter(([, v]) => v !== undefined));
  const current = await Tenant.findById(tenantId).select("name businessProfile").lean();
  if (!current) throw new AppError(404, "Tenant not found", "NOT_FOUND");
  if (identityLocked(current)) {
    // Name, legal name and GSTIN are locked once set: only a platform admin (PATCH /tenants/:id)
    // may change them. Re-sending the current values is fine (forms post the whole profile).
    const bp = current.businessProfile || {};
    const changed = [];
    if (body.name !== undefined && String(body.name).trim() !== String(current.name || "").trim()) changed.push("name");
    if (body.businessProfile?.legalName !== undefined && String(body.businessProfile.legalName).trim() !== String(bp.legalName || "").trim()) {
      changed.push("businessProfile.legalName");
    }
    if (body.businessProfile?.gstin !== undefined && String(body.businessProfile.gstin).trim().toUpperCase() !== String(bp.gstin || "").trim().toUpperCase()) {
      changed.push("businessProfile.gstin");
    }
    if (changed.length) {
      throw new AppError(
        403,
        "Store name, legal name and GSTIN are locked once set. Contact support.",
        "IDENTITY_LOCKED",
        { fields: Object.fromEntries(changed.map((f) => [f, "Locked: contact the platform admin to change it"])) }
      );
    }
  }
  return updateTenant(tenantId, patch);
}

/* ------------------------------------------------------------------ admin access log */

/**
 * Platform admin access to one store (X-Tenant-Id / ?tenantId=), newest first. Query: page, limit,
 * kind (read|write). Rows: { id, adminId, adminName, kind, method, path, reason, statusCode, at }.
 */
export async function listAccessLog(tenantId, query = {}) {
  if (!tenantId) throw new AppError(400, "No tenant on this account", "TENANT_REQUIRED");
  const { page, limit, skip } = paginate(query);
  const filter = { tenantId };
  if (query.kind === "read" || query.kind === "write") filter.kind = query.kind;
  const [rows, total] = await Promise.all([
    AdminAccessLog.find(filter).sort({ at: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    AdminAccessLog.countDocuments(filter),
  ]);
  const data = rows.map((r) => ({
    id: r._id,
    adminId: r.adminId,
    adminName: r.adminName || "Platform admin",
    kind: r.kind,
    method: r.method,
    path: r.path,
    reason: r.reason,
    statusCode: r.statusCode,
    at: r.at,
  }));
  return paginated(data, total, { page, limit });
}
