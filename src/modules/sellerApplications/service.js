import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { SellerApplication } from "./sellerApplication.model.js";
import { encryptSecret, decryptSecret, hashSecret } from "./crypto.js";
import { PAN_RX, IFSC_RX, ACCOUNT_RX, FSSAI_RX, PIN_RX } from "./validators.js";
import { User } from "../users/user.model.js";
import { Role } from "../rbac/role.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { Category } from "../catalog/category.model.js";
import { PrivateFile } from "../files/privateFile.model.js";
import { signPrivateFile } from "../files/routes.js";
import * as tenantService from "../tenants/service.js";
import { issueEmailVerification, SALT } from "../auth/service.js";
import { currentSellerTerms } from "../terms/service.js";
import { normalizeIndianState } from "../location/pincode.js";
import { partyStateCode } from "../invoices/service.js";
import { normalizeGstin } from "../../utils/gstin.js";
import { AppError } from "../../utils/AppError.js";
import { emitDomain } from "../../utils/events.js";
import { withTransaction, afterCommit, withSession } from "../../utils/transaction.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { loadUserRefs, userRef } from "../../utils/userRefs.js";
import { SELLER_APPLICANT_ROLE, SELLER_EVENTS, SELLER_REAPPLY_DAYS, SELLER_APPLICATION_STATUSES } from "../../config/constants.js";

const EDITABLE = ["draft", "more_info_needed"];
const REQUIRED_DOCS = ["gst_certificate", "pan_card", "cancelled_cheque"];
/** Tenant statuses that count as an "approved store" for the hard GSTIN duplicate block. */
const LIVE_TENANT_STATUSES = ["active", "trial", "paused", "suspended"];
const SIGNED_TTL_SECONDS = 5 * 60;
const DAY_MS = 86400000;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Phone → last 10 digits (Indian mobile) when there are at least 10 digits, else the digits. */
export function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export function isApplicantRole(role) {
  return Boolean(role && role.isSystem === true && role.slug === SELLER_APPLICANT_ROLE);
}

function signedLink(fileId) {
  const exp = Math.floor(Date.now() / 1000) + SIGNED_TTL_SECONDS;
  return {
    url: `/api/v1/files/private/${fileId}?exp=${exp}&sig=${signPrivateFile(String(fileId), String(exp))}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

async function documentsWithLinks(app) {
  const docs = app.documents || [];
  const files = docs.length ? await PrivateFile.find({ _id: { $in: docs.map((d) => d.fileId) } }).lean() : [];
  const byId = new Map(files.map((f) => [String(f._id), f]));
  return docs.map((d) => {
    const f = byId.get(String(d.fileId));
    if (!f) return { type: d.type, fileId: d.fileId, missing: true };
    return { type: d.type, fileId: d.fileId, originalName: f.originalName, mimeType: f.mimeType, size: f.size, ...signedLink(f._id) };
  });
}

/** User ids referenced by an application's history / reviewer notes (admin "who" labels). */
function actorIds(app) {
  return [...(app.history || []).map((h) => h.by), ...(app.reviewerNotes || []).map((n) => n.by)];
}

/**
 * API shape. Admin views resolve `history[].by` / `reviewerNotes[].by` to { id, name, email }
 * (`users`: optional prefetched map from loadUserRefs, else one query). Never exposes
 * `accountNumberEnc` / `accountHash`; `bank.accountNumber` (full) only with `revealBank`
 * (platform reviewer detail).
 */
export async function presentApplication(doc, { admin = false, revealBank = false, withDocs = true, users = null } = {}) {
  if (!doc) return null;
  const app = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  const userMap = admin ? users || (await loadUserRefs(actorIds(app))) : null;
  const bank = app.bank || {};
  const out = {
    id: app._id,
    userId: app.userId,
    email: app.email,
    phone: app.phone,
    status: app.status,
    business: app.business,
    registeredAddress: app.registeredAddress,
    pickupAddress: app.pickupAddress,
    bank: {
      holderName: bank.holderName || "",
      accountLast4: bank.accountLast4 || "",
      accountNumberMasked: bank.accountLast4 ? `XXXX${bank.accountLast4}` : "",
      ifsc: bank.ifsc || "",
      ...(revealBank ? { accountNumber: bank.accountNumberEnc ? decryptSecret(bank.accountNumberEnc) : "" } : {}),
    },
    fssai: app.fssai,
    sellsFood: Boolean(app.sellsFood),
    categories: app.categories || [],
    documents: withDocs ? await documentsWithLinks(app) : (app.documents || []).map((d) => ({ type: d.type, fileId: d.fileId })),
    termsVersion: app.termsVersion || "",
    planId: app.planId || null,
    planInterval: app.planInterval || null,
    termsAcceptedAt: app.termsAcceptedAt,
    moreInfoRequest: app.moreInfoRequest?.message ? { message: app.moreInfoRequest.message, at: app.moreInfoRequest.at } : null,
    rejection: app.rejection?.reason ? { reason: app.rejection.reason, at: app.rejection.at } : null,
    reapplyAfter: app.reapplyAfter,
    canReapply: app.status === "rejected" && !app.supersededBy && (!app.reapplyAfter || app.reapplyAfter <= new Date()),
    submittedAt: app.submittedAt,
    decidedAt: app.decidedAt,
    tenantId: app.tenantId,
    previousApplicationId: app.previousApplicationId,
    history: (app.history || []).map((h) => (admin ? { ...h, by: userRef(h.by, userMap) } : { from: h.from, to: h.to, at: h.at })),
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  };
  if (admin) {
    out.checks = app.checks;
    out.reviewerNotes = (app.reviewerNotes || []).map((n) => ({ ...n, by: userRef(n.by, userMap) }));
    out.moreInfoRequest = app.moreInfoRequest?.message ? app.moreInfoRequest : null;
    out.rejection = app.rejection?.reason ? app.rejection : null;
    out.reviewerId = app.reviewerId;
    out.decidedBy = app.decidedBy;
    out.supersededBy = app.supersededBy;
  }
  return out;
}

/* ------------------------------------------------------------------ applicant */

/**
 * Public seller sign-up. Seller accounts are separate from buyer accounts: ANY existing user with
 * this email → 409 EMAIL_IN_USE. Creates the applicant user + an empty draft, sends verification.
 */
export async function registerApplicant({ name, email, password, phone, businessName }) {
  const lowered = String(email).toLowerCase();
  const inUse = () =>
    new AppError(409, "This email already has an MS₹ account. Please use a different email for your seller account.", "EMAIL_IN_USE", {
      fields: { email: "Use a different email for your seller account" },
    });
  if (await User.exists({ email: lowered })) throw inUse();
  const role = await Role.findOne({ slug: SELLER_APPLICANT_ROLE, isSystem: true });
  if (!role) throw new AppError(500, "Seller applicant role not seeded", "SERVER_ERROR");

  let user;
  try {
    user = await User.create({
      name,
      email: lowered,
      phone: phone || "",
      passwordHash: await bcrypt.hash(password, SALT),
      tenantId: null,
      roleId: role._id,
      status: "active",
      emailVerified: false,
    });
  } catch (err) {
    if (err?.code === 11000) throw inUse();
    throw err;
  }
  const app = await SellerApplication.create({
    userId: user._id,
    email: lowered,
    phone: normalizePhone(phone),
    business: { legalName: businessName || "", tradeName: businessName || "" },
    history: [{ from: null, to: "draft", by: user._id, at: new Date(), note: "Registered" }],
  });
  await issueEmailVerification(user._id, user.email);
  emitDomain(SELLER_EVENTS.APPLIED, { userId: user._id, applicationId: app._id, email: lowered });
  return {
    ok: true,
    email: lowered,
    applicationId: app._id,
    emailVerificationRequired: true,
    message: "Seller account created. Verify your email, then sign in to complete your application.",
  };
}

export async function latestFor(userId, session = null) {
  return SellerApplication.findOne({ userId }, null, withSession(session)).sort({ createdAt: -1, _id: -1 });
}

async function requireMine(userId) {
  const app = await latestFor(userId);
  if (!app) throw new AppError(404, "No seller application found for this account", "NOT_FOUND");
  return app;
}

export async function getMine(user) {
  const app = await requireMine(user._id);
  const terms = await currentSellerTerms();
  const out = await presentApplication(app);
  out.emailVerified = Boolean(user.emailVerified);
  out.currentTermsVersion = terms.version;
  out.termsCurrent = out.termsVersion === terms.version;
  out.needsFssai = await needsFssai(app);
  out.missing = out.status === "draft" || out.status === "more_info_needed" ? Object.keys(await missingFields(app, terms)) : [];
  return out;
}

function addressSet(prefix, input, set) {
  for (const [k, v] of Object.entries(input || {})) {
    if (v === undefined) continue;
    if (k === "state") {
      const { state, stateCode } = normalizeIndianState(v);
      set[`${prefix}.state`] = state;
      set[`${prefix}.stateCode`] = stateCode;
    } else if (k === "phone") {
      set[`${prefix}.phone`] = normalizePhone(v);
    } else {
      set[`${prefix}.${k}`] = v;
    }
  }
}

function badFields(fields, message = "Validation failed") {
  const first = Object.entries(fields)[0];
  return new AppError(400, first ? `${first[0]}: ${first[1]}` : message, "VALIDATION_ERROR", { fields });
}

/** Draft editing (draft / more_info_needed only). */
export async function updateMine(req, body) {
  const app = await requireMine(req.user._id);
  if (!EDITABLE.includes(app.status)) {
    throw new AppError(409, `The application cannot be edited while it is ${app.status.replace(/_/g, " ")}`, "NOT_EDITABLE", { status: app.status });
  }
  const set = {};
  if (body.phone !== undefined) set.phone = normalizePhone(body.phone);
  for (const [k, v] of Object.entries(body.business || {})) if (v !== undefined) set[`business.${k}`] = v;
  addressSet("registeredAddress", body.registeredAddress, set);
  addressSet("pickupAddress", body.pickupAddress, set);
  if (body.bank) {
    if (body.bank.holderName !== undefined) set["bank.holderName"] = body.bank.holderName;
    if (body.bank.ifsc !== undefined) set["bank.ifsc"] = body.bank.ifsc;
    if (body.bank.accountNumber !== undefined) {
      const n = body.bank.accountNumber;
      set["bank.accountNumberEnc"] = n ? encryptSecret(n) : "";
      set["bank.accountLast4"] = n ? n.slice(-4) : "";
      set["bank.accountHash"] = n ? hashSecret(n) : "";
    }
  }
  if (body.fssai) {
    if (body.fssai.number !== undefined) set["fssai.number"] = body.fssai.number;
    if (body.fssai.expiresAt !== undefined) set["fssai.expiresAt"] = body.fssai.expiresAt || null;
  }
  if (body.sellsFood !== undefined) set.sellsFood = body.sellsFood;

  if (body.categories !== undefined) {
    const ids = [...new Set(body.categories.map(String))];
    const found = ids.length ? await Category.countDocuments({ _id: { $in: ids }, tenantId: null }) : 0;
    if (found !== ids.length) throw badFields({ categories: "Unknown category" });
    set.categories = ids;
  }

  if (body.documents !== undefined) {
    const ids = [...new Set(body.documents.map((d) => String(d.fileId)))];
    const owned = ids.length
      ? await PrivateFile.find({ _id: { $in: ids }, uploadedBy: req.user._id, folder: "kyc" }).select("_id").lean()
      : [];
    const ok = new Set(owned.map((f) => String(f._id)));
    const fields = {};
    body.documents.forEach((d, i) => {
      if (!ok.has(String(d.fileId))) fields[`documents.${i}.fileId`] = "File not found (upload it to your KYC documents first)";
    });
    if (Object.keys(fields).length) throw badFields(fields);
    set.documents = body.documents;
  }

  if (body.planId !== undefined) {
    if (!body.planId) {
      set.planId = null;
    } else {
      const { Plan } = await import("../billing/plan.model.js");
      const ok = await Plan.exists({ _id: body.planId, status: "active", isPublic: true, code: { $ne: "legacy" } });
      if (!ok) throw badFields({ planId: "Unknown plan" });
      set.planId = body.planId;
    }
  }
  if (body.planInterval !== undefined) set.planInterval = body.planInterval || null;

  if (body.termsVersion !== undefined) {
    const terms = await currentSellerTerms();
    if (body.termsVersion !== terms.version) {
      throw new AppError(409, "The seller terms have changed. Please read and accept the current version.", "TERMS_OUTDATED", {
        currentVersion: terms.version,
      });
    }
    set.termsVersion = terms.version;
    set.termsAcceptedAt = new Date();
    set.termsAcceptedIp = String(req.ip || "");
  }

  const updated = Object.keys(set).length
    ? await SellerApplication.findOneAndUpdate({ _id: app._id, status: { $in: EDITABLE } }, { $set: set }, { new: true, runValidators: true })
    : app;
  if (!updated) throw new AppError(409, "The application changed meanwhile. Reload and try again.", "CONFLICT");
  return getMine(req.user);
}

/** FSSAI needed: seller declared food, or (when categories carry the flag) any chosen category requires it. */
export async function needsFssai(app) {
  if (app.sellsFood) return true;
  if (!Category.schema.path("requiresFssai") || !app.categories?.length) return false;
  return Boolean(await Category.exists({ _id: { $in: app.categories }, requiresFssai: true }));
}

/** { path: message } of everything still missing before submit. */
async function missingFields(app, terms) {
  const m = {};
  const need = (cond, path, msg) => {
    if (!cond) m[path] = msg;
  };
  const b = app.business || {};
  need(String(app.phone || "").length >= 10, "phone", "Mobile number is required");
  need(b.legalName, "business.legalName", "Legal business name is required");
  need(b.businessType, "business.businessType", "Business type is required");
  need(normalizeGstin(b.gstin), "business.gstin", "A valid GSTIN is required");
  need(PAN_RX.test(b.pan || ""), "business.pan", "PAN is required");
  for (const prefix of ["registeredAddress", "pickupAddress"]) {
    const a = app[prefix] || {};
    need(a.addressLine1, `${prefix}.addressLine1`, "Address is required");
    need(a.city, `${prefix}.city`, "City is required");
    need(a.stateCode, `${prefix}.state`, "A valid Indian state is required");
    need(PIN_RX.test(a.postalCode || ""), `${prefix}.postalCode`, "PIN code is required");
  }
  const bank = app.bank || {};
  need(bank.holderName, "bank.holderName", "Account holder name is required");
  need(bank.accountNumberEnc && ACCOUNT_RX.test(decryptSecret(bank.accountNumberEnc) || ""), "bank.accountNumber", "Bank account number is required");
  need(IFSC_RX.test(bank.ifsc || ""), "bank.ifsc", "IFSC is required");

  const docs = app.documents || [];
  const existing = docs.length
    ? new Set((await PrivateFile.find({ _id: { $in: docs.map((d) => d.fileId) } }).select("_id").lean()).map((f) => String(f._id)))
    : new Set();
  const hasDoc = (type) => docs.some((d) => d.type === type && existing.has(String(d.fileId)));
  for (const type of REQUIRED_DOCS) need(hasDoc(type), `documents.${type}`, "Document is required");

  if (await needsFssai(app)) {
    const f = app.fssai || {};
    need(FSSAI_RX.test(f.number || ""), "fssai.number", "FSSAI licence number is required for food sellers");
    if (!f.expiresAt) m["fssai.expiresAt"] = "FSSAI licence expiry date is required";
    else if (new Date(f.expiresAt) <= new Date()) m["fssai.expiresAt"] = "FSSAI licence has expired";
    need(hasDoc("fssai"), "documents.fssai", "FSSAI licence document is required for food sellers");
  }
  need(app.termsVersion && app.termsVersion === terms.version, "termsVersion", "Accept the current seller terms");
  return m;
}

/**
 * Automated checks (recorded for the reviewer). Returns { checks, blockGstin } where blockGstin is
 * the live store that already has this exact GSTIN (hard block), if any.
 */
export async function runChecks(app, session = null) {
  const b = app.business || {};
  const gstin = normalizeGstin(b.gstin);
  const pan = String(b.pan || "").toUpperCase();
  const gstinStateCode = gstin ? partyStateCode("", gstin) : null;
  const pickupStateCode = app.pickupAddress?.stateCode || normalizeIndianState(app.pickupAddress?.state).stateCode || null;
  const duplicates = [];
  let blockGstin = null;
  const tenants = Tenant.collection;
  const opts = session ? { session } : {};
  const others = { userId: { $ne: app.userId }, status: { $ne: "draft" } };
  const add = (field, matchType, row, label) =>
    duplicates.push({ field, matchType, ref: row._id, refStatus: row.status, label: label || row.name || row.email || "" });

  if (gstin) {
    const rows = await tenants
      .find({ $or: [{ "kyc.gstin": gstin }, { "businessProfile.gstin": gstin }] }, { ...opts, projection: { name: 1, status: 1 } })
      .toArray();
    for (const row of rows) {
      add("gstin", "tenant", row);
      if (!blockGstin && LIVE_TENANT_STATUSES.includes(row.status)) blockGstin = row;
    }
    const apps = await SellerApplication.find({ ...others, "business.gstin": gstin }, "status email", withSession(session)).lean();
    for (const row of apps) add("gstin", "application", row, row.email);
  }
  if (PAN_RX.test(pan)) {
    const rows = await tenants.find({ "kyc.pan": pan }, { ...opts, projection: { name: 1, status: 1 } }).toArray();
    for (const row of rows) add("pan", "tenant", row);
    const apps = await SellerApplication.find({ ...others, "business.pan": pan }, "status email", withSession(session)).lean();
    for (const row of apps) add("pan", "application", row, row.email);
  }
  if (app.bank?.accountHash) {
    const rows = await tenants.find({ "kyc.bank.accountHash": app.bank.accountHash }, { ...opts, projection: { name: 1, status: 1 } }).toArray();
    for (const row of rows) add("bank", "tenant", row);
    const apps = await SellerApplication.find({ ...others, "bank.accountHash": app.bank.accountHash }, "status email", withSession(session)).lean();
    for (const row of apps) add("bank", "application", row, row.email);
  }
  const phone = normalizePhone(app.phone);
  if (phone.length >= 10) {
    const rows = await tenants
      .find({ "businessProfile.phone": { $regex: `${escapeRegex(phone)}$` } }, { ...opts, projection: { name: 1, status: 1 } })
      .toArray();
    for (const row of rows) add("phone", "tenant", row);
    const apps = await SellerApplication.find({ ...others, phone }, "status email", withSession(session)).lean();
    for (const row of apps) add("phone", "application", row, row.email);
  }
  if (app.email) {
    const rows = await tenants
      .find({ "businessProfile.email": { $regex: `^${escapeRegex(app.email)}$`, $options: "i" } }, { ...opts, projection: { name: 1, status: 1 } })
      .toArray();
    for (const row of rows) add("email", "tenant", row);
  }

  return {
    blockGstin,
    checks: {
      ranAt: new Date(),
      gstinValid: Boolean(gstin),
      panMatchesGstin: Boolean(gstin && PAN_RX.test(pan) && gstin.slice(2, 12) === pan),
      stateMatches: Boolean(gstinStateCode && pickupStateCode && gstinStateCode === pickupStateCode),
      gstinStateCode,
      pickupStateCode,
      duplicates,
    },
  };
}

function gstinExists() {
  return new AppError(409, "A store with this GSTIN is already registered on MS₹. Contact support if this is your business.", "GSTIN_EXISTS", {
    fields: { "business.gstin": "GSTIN already registered" },
  });
}

export async function submitMine(req, body = {}) {
  const user = await User.findById(req.user._id);
  let app = await requireMine(req.user._id);
  if (!EDITABLE.includes(app.status)) {
    throw new AppError(409, `The application is already ${app.status.replace(/_/g, " ")}`, "INVALID_STATE", { status: app.status });
  }
  if (!user?.emailVerified) throw new AppError(403, "Please verify your email address before submitting", "EMAIL_NOT_VERIFIED");
  if (body.termsVersion) {
    await updateMine(req, { termsVersion: body.termsVersion });
    app = await requireMine(req.user._id);
  }
  const terms = await currentSellerTerms();
  const missing = await missingFields(app, terms);
  if (Object.keys(missing).length) {
    throw new AppError(400, "Complete the application before submitting", "VALIDATION_ERROR", { fields: missing });
  }
  const { checks, blockGstin } = await runChecks(app);
  if (!checks.panMatchesGstin) {
    throw new AppError(400, "PAN must match characters 3-12 of the GSTIN", "PAN_GSTIN_MISMATCH", {
      fields: { "business.pan": "PAN does not match the GSTIN" },
    });
  }
  if (blockGstin) throw gstinExists();

  const from = app.status;
  const now = new Date();
  const updated = await SellerApplication.findOneAndUpdate(
    { _id: app._id, status: from },
    {
      $set: { status: "submitted", submittedAt: now, checks },
      $push: { history: { from, to: "submitted", by: req.user._id, at: now, note: from === "more_info_needed" ? "Resubmitted" : "" } },
    },
    { new: true }
  );
  if (!updated) throw new AppError(409, "The application changed meanwhile. Reload and try again.", "CONFLICT");
  emitDomain(SELLER_EVENTS.SUBMITTED, {
    userId: updated.userId,
    applicationId: updated._id,
    email: updated.email,
    businessName: updated.business?.tradeName || updated.business?.legalName || "",
    resubmitted: from === "more_info_needed",
    duplicates: checks.duplicates.length,
  });
  return getMine(user);
}

/** Rejected applicant starts over (after reapplyAfter): clones the rejected application into a new draft. */
export async function reapplyMine(req) {
  const app = await requireMine(req.user._id);
  if (app.status !== "rejected") {
    throw new AppError(409, "Only a rejected application can be reapplied", "INVALID_STATE", { status: app.status });
  }
  if (app.reapplyAfter && app.reapplyAfter > new Date()) {
    throw new AppError(409, `You can reapply after ${app.reapplyAfter.toISOString().slice(0, 10)}`, "REAPPLY_LOCKED", {
      reapplyAfter: app.reapplyAfter,
    });
  }
  const newId = new mongoose.Types.ObjectId();
  const claimed = await SellerApplication.findOneAndUpdate(
    { _id: app._id, status: "rejected", supersededBy: null },
    { $set: { supersededBy: newId } },
    { new: true }
  );
  if (!claimed) throw new AppError(409, "This application was already reapplied", "INVALID_STATE");
  const src = app.toObject();
  const draft = await SellerApplication.create({
    _id: newId,
    userId: src.userId,
    email: src.email,
    phone: src.phone,
    status: "draft",
    business: src.business,
    registeredAddress: src.registeredAddress,
    pickupAddress: src.pickupAddress,
    bank: src.bank,
    fssai: src.fssai,
    sellsFood: src.sellsFood,
    categories: src.categories,
    documents: src.documents,
    planId: src.planId || null,
    planInterval: src.planInterval || null,
    previousApplicationId: src._id,
    history: [{ from: null, to: "draft", by: req.user._id, at: new Date(), note: "Reapplied after rejection" }],
  });
  return getMine(req.user).then((out) => ({ ...out, id: draft._id }));
}

/** Applicant KYC upload (folder kyc, tenantId null, uploadedBy = applicant). */
export async function saveApplicantDocument(req, savedFile, type) {
  const row = await PrivateFile.create({
    tenantId: null,
    uploadedBy: req.user._id,
    key: savedFile.key,
    filename: savedFile.filename,
    originalName: savedFile.originalName,
    mimeType: savedFile.mimeType,
    size: savedFile.size,
    folder: "kyc",
    purpose: type,
  });
  return { id: row._id, fileId: row._id, type, originalName: row.originalName, mimeType: row.mimeType, size: row.size, ...signedLink(row._id) };
}

export async function applicantDocumentLink(req, fileId) {
  const row = await PrivateFile.findOne({ _id: fileId, uploadedBy: req.user._id }).lean();
  if (!row) throw new AppError(404, "File not found", "NOT_FOUND");
  return signedLink(row._id);
}

/* ------------------------------------------------------------------ platform review */

export async function listApplications(query = {}) {
  const { page, limit, skip } = paginate(query);
  const filter = {};
  if (query.status) filter.status = { $in: String(query.status).split(",").map((s) => s.trim()) };
  if (query.q) {
    const rx = { $regex: escapeRegex(String(query.q).trim()), $options: "i" };
    filter.$or = [
      { email: rx },
      { phone: rx },
      { "business.legalName": rx },
      { "business.tradeName": rx },
      { "business.gstin": rx },
      { "business.pan": rx },
    ];
  }
  const [rows, total, grouped] = await Promise.all([
    SellerApplication.find(filter).sort({ submittedAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    SellerApplication.countDocuments(filter),
    SellerApplication.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  const counts = Object.fromEntries(SELLER_APPLICATION_STATUSES.map((s) => [s, 0]));
  for (const g of grouped) counts[g._id] = g.n;
  const users = await loadUserRefs(rows.flatMap(actorIds));
  const data = await Promise.all(
    rows.map(async (r) => {
      const p = await presentApplication(r, { admin: true, withDocs: false, users });
      return { ...p, duplicateCount: r.checks?.duplicates?.length || 0 };
    })
  );
  return { ...paginated(data, total, { page, limit }), counts };
}

async function loadById(id, session = null) {
  const app = await SellerApplication.findById(id, null, withSession(session));
  if (!app) throw new AppError(404, "Application not found", "NOT_FOUND");
  return app;
}

const CHECK_REFRESH_STATUSES = new Set(["submitted", "under_review", "more_info_needed"]);

/** Reviewer detail. `revealBank` (GET detail only) adds the full account number; action responses
 * leave it out so it never lands in audit-log snapshots. */
export async function getApplication(id, { revealBank = false, refreshChecks = false } = {}) {
  const app = await loadById(id);
  // R14: duplicates are only known at submit time; an application that came in later can match
  // this one, so the reviewer's detail view re-runs (and stores) the checks while still in review.
  if (refreshChecks && CHECK_REFRESH_STATUSES.has(app.status)) {
    const { checks } = await runChecks(app);
    const res = await SellerApplication.updateOne({ _id: app._id, status: app.status }, { $set: { checks } });
    if (res.modifiedCount) app.checks = checks;
  }
  const out = await presentApplication(app, { admin: true, revealBank });
  const user = await User.findById(app.userId).select("name email phone status emailVerified lastLoginAt").lean();
  out.applicant = user
    ? { id: user._id, name: user.name, email: user.email, phone: user.phone, status: user.status, emailVerified: Boolean(user.emailVerified), lastLoginAt: user.lastLoginAt }
    : null;
  out.categoriesDetail = app.categories?.length
    ? await Category.find({ _id: { $in: app.categories } }).select("name slug").lean()
    : [];
  out.needsFssai = await needsFssai(app);
  return out;
}

function invalidState(app, action) {
  return new AppError(409, `Cannot ${action} an application that is ${app.status.replace(/_/g, " ")}`, "INVALID_STATE", { status: app.status });
}

/** Conditional status move (status must still be `app.status`). */
async function move(app, to, { by, note = "", set = {}, push = {}, session = null }) {
  const now = new Date();
  const updated = await SellerApplication.findOneAndUpdate(
    { _id: app._id, status: app.status },
    { $set: { status: to, ...set }, $push: { history: { from: app.status, to, by, at: now, note }, ...push } },
    withSession(session, { new: true })
  );
  if (!updated) throw new AppError(409, "The application changed meanwhile. Reload and try again.", "CONFLICT");
  return updated;
}

export async function startReview(req, id, body = {}) {
  const app = await loadById(id);
  if (app.status !== "submitted") throw invalidState(app, "start reviewing");
  await move(app, "under_review", { by: req.user._id, note: body?.note || "", set: { reviewStartedAt: new Date(), reviewerId: req.user._id } });
  return getApplication(id);
}

export async function requestInfo(req, id, { message }) {
  const app = await loadById(id);
  if (!["submitted", "under_review"].includes(app.status)) throw invalidState(app, "request more information on");
  const updated = await move(app, "more_info_needed", {
    by: req.user._id,
    note: message,
    set: { moreInfoRequest: { message, at: new Date(), by: req.user._id } },
  });
  emitDomain(SELLER_EVENTS.MORE_INFO, { userId: updated.userId, applicationId: updated._id, message });
  return getApplication(id);
}

export async function reject(req, id, { reason }) {
  const app = await loadById(id);
  if (!["submitted", "under_review", "more_info_needed"].includes(app.status)) throw invalidState(app, "reject");
  const now = new Date();
  const reapplyAfter = new Date(now.getTime() + SELLER_REAPPLY_DAYS * DAY_MS);
  const updated = await move(app, "rejected", {
    by: req.user._id,
    note: reason,
    set: { rejection: { reason, at: now, by: req.user._id }, reapplyAfter, decidedAt: now, decidedBy: req.user._id },
  });
  emitDomain(SELLER_EVENTS.REJECTED, { userId: updated.userId, applicationId: updated._id, reason, reapplyAfter });
  return getApplication(id);
}

/**
 * Approve: creates the store via tenants/service.js createTenantFromApplication (p2-states) in the
 * same transaction; the applicant becomes the store's tenant_admin.
 */
export async function approve(req, id, { note, planId, planInterval } = {}) {
  const create = tenantService.createTenantFromApplication;
  if (typeof create !== "function") {
    throw new AppError(501, "Store creation from applications is not available yet", "NOT_IMPLEMENTED");
  }
  const result = await withTransaction(async (session) => {
    const app = await loadById(id, session);
    if (!["submitted", "under_review"].includes(app.status)) throw invalidState(app, "approve");
    const { blockGstin } = await runChecks(app, session);
    if (blockGstin) throw gstinExists();
    if (planId || planInterval) {
      // Reviewer's plan override (phase 3 billing) is recorded on the application and used by the store creation.
      const set = {};
      if (planId) set.planId = planId;
      if (planInterval) set.planInterval = planInterval;
      await SellerApplication.updateOne({ _id: app._id }, { $set: set }, withSession(session));
      Object.assign(app, set);
    }
    const tenant = await create(app, { by: req.user._id, session });
    const tenantId = tenant?._id || tenant?.id || tenant;
    const now = new Date();
    const updated = await move(app, "approved", {
      by: req.user._id,
      note: note || "",
      set: { decidedAt: now, decidedBy: req.user._id, tenantId },
      push: note ? { reviewerNotes: { text: note, by: req.user._id, at: now } } : {},
      session,
    });
    afterCommit(session, () =>
      emitDomain(SELLER_EVENTS.APPROVED, {
        userId: updated.userId,
        applicationId: updated._id,
        tenantId,
        businessName: updated.business?.tradeName || updated.business?.legalName || "",
      })
    );
    return { tenantId };
  });
  const out = await getApplication(id);
  return { ...out, tenantId: result.tenantId };
}

export async function addNote(req, id, { text }) {
  const app = await loadById(id);
  await SellerApplication.updateOne({ _id: app._id }, { $push: { reviewerNotes: { text, by: req.user._id, at: new Date() } } });
  return getApplication(id);
}
