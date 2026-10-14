import mongoose from "mongoose";
import {
  Dispute,
  DisputeCounter,
  OPEN_DISPUTE_STATUSES,
  CLOSED_DISPUTE_STATUSES,
  DISPUTE_STATUSES,
  DISPUTE_STATUS_LABELS,
  DISPUTE_KIND_LABELS,
} from "./dispute.model.js";
import { Order } from "../orders/order.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { User } from "../users/user.model.js";
import { PrivateFile } from "../files/privateFile.model.js";
import { SellerLedgerEntry } from "../payouts/models.js";
import { reopenReturnForDispute, refundForDispute, disputedUnits, disputeValue } from "../orders/lifecycle.js";
import { refundedSoFar } from "../orders/returns.js";
import { phase6Sla, HOUR } from "../orders/sla.js";
import { STATUS_LABELS } from "../orders/statuses.js";
import { AppError } from "../../utils/AppError.js";
import { emitDomain } from "../../utils/events.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { withTransaction, withSession } from "../../utils/transaction.js";
import { round2 } from "../pricing/engine.js";

/**
 * Phase 6 disputes (buyer escalates a rejected / pickup-failed / QC-rejected return).
 *   buyer:  list / get / open (eligibility checked) / message / withdraw
 *   seller: list / get / message (store staff with returns.manage)
 *   admin:  queue / get / decide (refund | reopen | reject) / request-info / message (disputes.manage)
 * Evidence = private files (folder `disputes`) attached to messages; links via fileLink().
 */

const idStr = (v) => String(v?._id || v || "");
const MAX_FILES_PER_MESSAGE = 10;

/* ------------------------------------------------------------------ eligibility */

/** Dispute kind + the moment the buyer learned the negative outcome, or null when not disputable. */
export function disputeBasis(ret) {
  if (!ret) return null;
  if (ret.status === "rejected") return { kind: "return_rejected", at: ret.decidedAt || ret.updatedAt || null };
  if (ret.status === "pickup_failed") return { kind: "pickup_failed", at: ret.pickupFailedAt || ret.updatedAt || null };
  if ((ret.status === "qc_rejected" || ret.status === "received") && ret.qc?.items?.length) return { kind: "qc_rejected", at: ret.qc.at || ret.receivedAt || null };
  return null;
}

/**
 * Buyer-facing dispute info for one return:
 *   null (nothing to dispute) or { kind, eligible, deadline, disputeId, status, statusLabel, reason }.
 */
export function eligibilityFor(ret, { windowDays = 7, now = Date.now() } = {}) {
  const basis = disputeBasis(ret);
  if (!basis && !ret?.disputeId) return null;
  const deadline = basis?.at ? new Date(new Date(basis.at).getTime() + windowDays * 24 * HOUR) : null;
  const out = {
    kind: basis?.kind || null,
    eligible: false,
    deadline,
    disputeId: ret.disputeId || null,
    status: ret.disputeStatus || null,
    statusLabel: ret.disputeStatus ? DISPUTE_STATUS_LABELS[ret.disputeStatus] || ret.disputeStatus : null,
    reason: "",
  };
  if (ret.disputeId) out.reason = "A dispute was already opened for this return";
  else if (ret.reopenedAs) out.reason = "This return was reopened";
  else if (!deadline || now > deadline.getTime()) out.reason = `The ${windowDays}-day dispute window has ended`;
  else out.eligible = true;
  return out;
}

/** Adds `dispute` (eligibility) to every return of an API order object (GET /orders/:id). */
export async function attachDisputeInfo(plainOrder) {
  if (!plainOrder?.returns?.length) return plainOrder;
  const sla = await phase6Sla();
  plainOrder.returns = plainOrder.returns.map((r) => ({ ...r, dispute: eligibilityFor(r, { windowDays: sla.disputeWindowDays }) }));
  return plainOrder;
}

/* ------------------------------------------------------------------ helpers */

async function nextNumber(session) {
  const row = await DisputeCounter.findOneAndUpdate({ _id: "DSP" }, { $inc: { seq: 1 } }, withSession(session, { upsert: true, new: true }));
  return `DSP-${String(row.seq).padStart(6, "0")}`;
}

/** Keep the order's return record in sync (disputeOpen holds seller payouts). */
async function syncOrder(dispute, session = null) {
  const open = OPEN_DISPUTE_STATUSES.includes(dispute.status);
  await Order.updateOne(
    { _id: dispute.orderId, "returns._id": dispute.returnId },
    { $set: { "returns.$.disputeId": dispute._id, "returns.$.disputeStatus": dispute.status, "returns.$.disputeOpen": open } },
    withSession(session)
  );
}

/**
 * Payout hold (phase 4 finality): an order with an open dispute is not final. If the order was
 * already final, its not-yet-paid ledger lines go back on hold until the dispute closes (the
 * payouts job releases them again; finalAt is recomputed).
 */
async function holdPayouts(orderId, session) {
  const order = await Order.findById(orderId, "payout", withSession(session)).lean();
  if (!order?.payout?.finalAt) return;
  await Order.updateOne({ _id: orderId }, { $set: { "payout.finalAt": null } }, withSession(session));
  await SellerLedgerEntry.updateMany(
    { orderId, payoutId: null, availableAt: { $ne: null } },
    { $set: { availableAt: null, heldReason: "dispute" } },
    withSession(session)
  );
}

function eventPayload(d, extra = {}) {
  return {
    disputeId: d._id,
    number: d.number,
    tenantId: d.tenantId,
    orderId: d.orderId,
    orderNumber: d.orderNumber,
    buyerId: d.buyerId,
    returnId: d.returnId,
    status: d.status,
    kind: d.kind,
    claimAmount: d.claimAmount,
    resource: "dispute",
    resourceId: d._id,
    ...extra,
  };
}

/** Files a party may attach: own uploads in folder disputes (seller: store files in disputes / delivery). */
async function checkFiles(fileIds, { role, userId, tenantId }) {
  const ids = [...new Set((fileIds || []).map(String))];
  if (!ids.length) return [];
  if (ids.length > MAX_FILES_PER_MESSAGE) throw new AppError(400, `At most ${MAX_FILES_PER_MESSAGE} files per message`, "VALIDATION_ERROR");
  if (ids.some((id) => !mongoose.isValidObjectId(id))) throw new AppError(400, "Invalid file id", "VALIDATION_ERROR");
  const filter = { _id: { $in: ids } };
  if (role === "seller") Object.assign(filter, { tenantId, folder: { $in: ["disputes", "delivery"] } });
  else Object.assign(filter, { uploadedBy: userId, folder: "disputes" });
  const rows = await PrivateFile.find(filter).select("_id").lean();
  if (rows.length !== ids.length) throw new AppError(400, "Unknown file: upload evidence to /files/private with folder=disputes first", "VALIDATION_ERROR");
  return ids.map((id) => new mongoose.Types.ObjectId(id));
}

function viewerRole(req) {
  if (req.isPlatformAdmin) return "admin";
  if (req.isBuyer) return "buyer";
  return "seller";
}

/* ------------------------------------------------------------------ presenters */

function fileMeta(row) {
  return { id: row._id, originalName: row.originalName || row.filename || "", mimeType: row.mimeType || "", size: row.size || 0, folder: row.folder };
}

async function filesById(ids) {
  if (!ids.length) return new Map();
  const rows = await PrivateFile.find({ _id: { $in: ids } }).select("originalName filename mimeType size folder").lean();
  return new Map(rows.map((r) => [String(r._id), fileMeta(r)]));
}

function allowedActions(d, role) {
  const open = OPEN_DISPUTE_STATUSES.includes(d.status);
  return {
    message: open,
    withdraw: open && role === "buyer",
    decide: open && role === "admin",
    requestInfo: open && role === "admin",
  };
}

function rowOf(d, role, { store, buyer } = {}) {
  const last = (d.messages || []).at(-1);
  return {
    id: d._id,
    number: d.number,
    status: d.status,
    statusLabel: DISPUTE_STATUS_LABELS[d.status] || d.status,
    kind: d.kind,
    kindLabel: DISPUTE_KIND_LABELS[d.kind] || d.kind,
    tenantId: d.tenantId,
    store: store ? { id: store._id, name: store.name, slug: store.slug } : null,
    orderId: d.orderId,
    orderNumber: d.orderNumber,
    returnId: d.returnId,
    buyer: role === "buyer" ? null : buyer ? { id: buyer._id, name: buyer.name || "", ...(role === "admin" ? { email: buyer.email || "", phone: buyer.phone || "" } : {}) } : null,
    summary: d.summary,
    claimAmount: d.claimAmount,
    awaiting: d.awaiting || "",
    respondBy: d.respondBy,
    sellerRespondBy: d.sellerRespondBy,
    timedOut: Boolean(d.timedOut),
    openedAt: d.openedAt,
    closedAt: d.closedAt,
    ageHours: Math.floor((Date.now() - new Date(d.openedAt || d.createdAt).getTime()) / HOUR),
    messagesCount: (d.messages || []).length,
    lastMessageAt: last?.at || null,
    lastMessageFrom: last?.from || null,
    decision: d.decision?.action ? { action: d.decision.action, amount: d.decision.amount, reason: d.decision.reason, at: d.decision.at } : null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

async function present(d, role) {
  const [store, buyer, order] = await Promise.all([
    Tenant.findById(d.tenantId, "name slug").lean(),
    User.findById(d.buyerId, "name email phone").lean(),
    Order.findById(d.orderId, "orderNumber status returns items total refunds paymentMethod").lean(),
  ]);
  const ret = (order?.returns || []).find((r) => idStr(r._id) === idStr(d.returnId)) || null;
  const ids = [...new Set([...(d.messages || []).flatMap((m) => (m.fileIds || []).map(String)), ...(ret?.qc?.photos || []).map(String)])];
  const files = await filesById(ids);
  const userIds = [...new Set((d.messages || []).map((m) => idStr(m.userId)).filter(Boolean))];
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }, "name").lean() : [];
  const names = new Map(users.map((u) => [String(u._id), u.name || ""]));
  const out = rowOf(d, role, { store, buyer });
  out.items = (d.items || []).map((i) => ({ itemId: i.itemId, name: i.name, qty: i.qty, amount: i.amount }));
  out.messages = (d.messages || []).map((m) => ({
    id: m._id,
    from: m.from,
    // Staff names are shown to the platform only; buyers / sellers see the side.
    byName: role === "admin" || (role === "seller" && m.from === "seller") || (role === "buyer" && m.from === "buyer") ? names.get(idStr(m.userId)) || "" : "",
    kind: m.kind,
    to: m.to || "",
    text: m.text,
    files: (m.fileIds || []).map((id) => files.get(String(id))).filter(Boolean),
    at: m.at,
  }));
  out.history = (d.history || []).map((h) => ({ status: h.status, statusLabel: DISPUTE_STATUS_LABELS[h.status] || h.status, at: h.at, note: h.note }));
  out.decision = d.decision?.action
    ? { action: d.decision.action, amount: d.decision.amount, reason: d.decision.reason, at: d.decision.at, refundMethod: d.decision.refundMethod || "", newReturnId: d.decision.newReturnId || null }
    : null;
  out.order = order
    ? {
        id: order._id,
        orderNumber: order.orderNumber,
        status: order.status,
        statusLabel: STATUS_LABELS[order.status] || order.status,
        total: order.total,
        paymentMethod: order.paymentMethod,
        refundable: round2(Math.max(0, (order.total || 0) - refundedSoFar(order))),
      }
    : null;
  out.return = ret
    ? {
        id: ret._id,
        status: ret.status,
        reason: ret.reason,
        reasonCode: ret.reasonCode,
        sellerFault: Boolean(ret.sellerFault),
        note: ret.note,
        items: (ret.items || []).map((i) => ({ itemId: i.itemId, name: i.name, qty: i.qty, amount: i.amount })),
        refundAmount: ret.refundAmount,
        requestedAt: ret.requestedAt,
        decidedAt: ret.decidedAt,
        decisionNote: ret.decisionNote,
        autoApproved: Boolean(ret.autoApproved),
        pickupFailedAt: ret.pickupFailedAt,
        pickupFailReason: ret.pickupFailReason || "",
        receivedAt: ret.receivedAt,
        qc: ret.qc?.items?.length
          ? {
              at: ret.qc.at,
              note: ret.qc.note,
              disposition: ret.qc.disposition,
              items: ret.qc.items,
              rejectedAmount: ret.qc.rejectedAmount,
              photos: (ret.qc.photos || []).map((id) => files.get(String(id))).filter(Boolean),
            }
          : null,
        reopenedAs: ret.reopenedAs || null,
      }
    : null;
  out.allowedActions = allowedActions(d, role);
  return out;
}

async function presentRows(list, role) {
  const tenantIds = [...new Set(list.map((d) => idStr(d.tenantId)))];
  const buyerIds = [...new Set(list.map((d) => idStr(d.buyerId)))];
  const [stores, buyers] = await Promise.all([
    Tenant.find({ _id: { $in: tenantIds } }, "name slug").lean(),
    role === "buyer" ? [] : User.find({ _id: { $in: buyerIds } }, "name email phone").lean(),
  ]);
  const s = new Map(stores.map((t) => [String(t._id), t]));
  const b = new Map(buyers.map((u) => [String(u._id), u]));
  return list.map((d) => rowOf(d, role, { store: s.get(idStr(d.tenantId)), buyer: b.get(idStr(d.buyerId)) }));
}

/* ------------------------------------------------------------------ loading */

async function load(req, id) {
  if (!mongoose.isValidObjectId(String(id))) throw new AppError(404, "Dispute not found", "NOT_FOUND");
  const role = viewerRole(req);
  const filter = { _id: id };
  if (role === "buyer") filter.buyerId = req.user._id;
  else if (role === "seller") {
    if (!req.tenantId) throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
    filter.tenantId = req.tenantId;
  }
  const d = await Dispute.findOne(filter);
  if (!d) throw new AppError(404, "Dispute not found", "NOT_FOUND");
  return { d, role };
}

/* ------------------------------------------------------------------ lists */

function statusList(raw) {
  if (!raw) return null;
  const list = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes("open_all")) return OPEN_DISPUTE_STATUSES;
  if (list.includes("closed_all")) return CLOSED_DISPUTE_STATUSES;
  const bad = list.filter((s) => !DISPUTE_STATUSES.includes(s));
  if (bad.length) throw new AppError(400, `Unknown status: ${bad.join(", ")}`, "VALIDATION_ERROR");
  return list;
}

const SORTS = { newest: { createdAt: -1, _id: -1 }, oldest: { createdAt: 1, _id: 1 }, respondBy: { respondBy: 1, createdAt: 1 }, updated: { updatedAt: -1 } };

/** GET /disputes (buyer: own; seller staff: the store's). Query: status (comma list | open_all | closed_all), page, limit. */
export async function listMine(req) {
  const role = viewerRole(req);
  const { page, limit, skip } = paginate(req.query);
  const filter = {};
  if (role === "buyer") filter.buyerId = req.user._id;
  else if (role === "seller") {
    if (!req.tenantId) throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
    filter.tenantId = new mongoose.Types.ObjectId(String(req.tenantId));
  } else if (req.tenantId) filter.tenantId = new mongoose.Types.ObjectId(String(req.tenantId));
  const statuses = statusList(req.query.status);
  if (statuses) filter.status = { $in: statuses };
  if (req.query.orderId && mongoose.isValidObjectId(String(req.query.orderId))) filter.orderId = new mongoose.Types.ObjectId(String(req.query.orderId));
  const [list, total, counts] = await Promise.all([
    Dispute.find(filter).sort(SORTS[req.query.sort] || SORTS.newest).skip(skip).limit(limit).lean(),
    Dispute.countDocuments(filter),
    countByStatus({ ...filter, status: undefined }),
  ]);
  return { ...paginated(await presentRows(list, role === "admin" ? "admin" : role), total, { page, limit }), counts };
}

async function countByStatus(filter) {
  const clean = Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined));
  const rows = await Dispute.aggregate([{ $match: clean }, { $group: { _id: "$status", n: { $sum: 1 } } }]);
  const out = Object.fromEntries(DISPUTE_STATUSES.map((s) => [s, 0]));
  for (const r of rows) out[r._id] = r.n;
  return out;
}

/**
 * GET /admin/disputes: status (comma list | open_all | closed_all; default all), tenantId,
 * minAgeHours / age (24h | 3d | 7d: opened at least that long ago), q (dispute / order number),
 * sort (newest | oldest | respondBy | updated), page, limit. -> { data, meta, counts }.
 */
export async function adminList(query = {}) {
  const { page, limit, skip } = paginate(query);
  const filter = {};
  const statuses = statusList(query.status);
  if (statuses) filter.status = { $in: statuses };
  if (query.tenantId) {
    if (!mongoose.isValidObjectId(String(query.tenantId))) throw new AppError(400, "Invalid tenantId", "VALIDATION_ERROR");
    filter.tenantId = new mongoose.Types.ObjectId(String(query.tenantId));
  }
  const ages = { "24h": 24, "3d": 72, "7d": 168 };
  const minAge = Number(query.minAgeHours) || ages[String(query.age || "")] || 0;
  if (minAge > 0) filter.openedAt = { $lte: new Date(Date.now() - minAge * HOUR) };
  if (query.q) {
    const q = String(query.q).trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{ number: new RegExp(q, "i") }, { orderNumber: new RegExp(q, "i") }];
  }
  const countFilter = { ...filter };
  delete countFilter.status;
  const [list, total, counts] = await Promise.all([
    Dispute.find(filter).sort(SORTS[query.sort] || SORTS.oldest).skip(skip).limit(limit).lean(),
    Dispute.countDocuments(filter),
    countByStatus(countFilter),
  ]);
  return { ...paginated(await presentRows(list, "admin"), total, { page, limit }), counts };
}

export async function getOne(req, id) {
  const { d, role } = await load(req, id);
  return present(d, role);
}

/* ------------------------------------------------------------------ open */

/**
 * POST /disputes { orderId, returnId, message, fileIds? } (buyer of the order). The return must
 * be rejected / pickup-failed / QC-rejected, within disputes.windowDays, and not disputed yet.
 * Errors: 404 order / return, 409 DISPUTE_EXISTS, 400 NOT_DISPUTABLE / DISPUTE_WINDOW_OVER.
 */
export async function openDispute(req, { orderId, returnId, message, fileIds = [] }) {
  if (!req.isBuyer || req.isPlatformAdmin) throw new AppError(403, "Only the buyer can open a dispute", "FORBIDDEN");
  if (!mongoose.isValidObjectId(String(orderId)) || !mongoose.isValidObjectId(String(returnId))) throw new AppError(404, "Order not found", "NOT_FOUND");
  const order = await Order.findOne({ _id: orderId, buyerId: req.user._id });
  if (!order) throw new AppError(404, "Order not found", "NOT_FOUND");
  const ret = (order.returns || []).find((r) => idStr(r._id) === String(returnId));
  if (!ret) throw new AppError(404, "Return not found", "NOT_FOUND");
  const sla = await phase6Sla(order.tenantId);
  const info = eligibilityFor(ret, { windowDays: sla.disputeWindowDays });
  if (ret.disputeId) throw new AppError(409, "A dispute was already opened for this return", "DISPUTE_EXISTS");
  if (!info?.kind) throw new AppError(400, "Only a rejected return, a failed pickup or items rejected at the quality check can be disputed", "NOT_DISPUTABLE");
  if (!info.eligible) {
    throw new AppError(400, info.reason || "This return cannot be disputed", ret.reopenedAs ? "NOT_DISPUTABLE" : "DISPUTE_WINDOW_OVER");
  }
  const text = String(message || "").trim();
  if (text.length < 5) throw new AppError(400, "Describe the problem (at least a few words)", "VALIDATION_ERROR");
  const files = await checkFiles(fileIds, { role: "buyer", userId: req.user._id });
  const value = disputeValue(order, ret);
  const units = disputedUnits(ret);
  const now = new Date();
  const respondBy = new Date(now.getTime() + sla.sellerResponseHours * HOUR);

  const created = await withTransaction(async (session) => {
    const number = await nextNumber(session);
    const [d] = await Dispute.create(
      [
        {
          number,
          tenantId: order.tenantId,
          orderId: order._id,
          orderNumber: order.orderNumber,
          returnId: ret._id,
          returnKey: String(ret._id),
          buyerId: order.buyerId,
          kind: info.kind,
          status: "open",
          summary: text.slice(0, 2000),
          items: units.map((u) => ({ ...u, amount: value.items.find((v) => idStr(v.itemId) === idStr(u.itemId))?.amount || 0 })),
          claimAmount: round2(Math.min(value.refundAmount, Math.max(0, (order.total || 0) - refundedSoFar(order)))),
          messages: [{ from: "buyer", userId: req.user._id, kind: "message", text: text.slice(0, 4000), fileIds: files, at: now }],
          awaiting: "seller",
          respondBy,
          sellerRespondBy: respondBy,
          history: [{ status: "open", at: now, by: req.user._id, note: "Dispute opened by the buyer" }],
          openedAt: now,
        },
      ],
      { session }
    ).catch((err) => {
      if (err?.code === 11000) throw new AppError(409, "A dispute was already opened for this return", "DISPUTE_EXISTS");
      throw err;
    });
    const res = await Order.updateOne(
      { _id: order._id, returns: { $elemMatch: { _id: ret._id, disputeId: null } } },
      { $set: { "returns.$.disputeId": d._id, "returns.$.disputeStatus": "open", "returns.$.disputeOpen": true } },
      { session }
    );
    if (!res.modifiedCount) throw new AppError(409, "A dispute was already opened for this return", "DISPUTE_EXISTS");
    await holdPayouts(order._id, session);
    return d;
  });
  emitDomain("DISPUTE_OPENED", eventPayload(created, { respondBy, preview: text.slice(0, 200) }));
  return present(created, "buyer");
}

/* ------------------------------------------------------------------ messages */

function moveToReview(set, history, { note, by = null, timedOut = false }) {
  set.status = "under_review";
  set.awaiting = "admin";
  set.respondBy = null;
  set.reviewAt = new Date();
  if (timedOut) set.timedOut = true;
  history.push({ status: "under_review", at: new Date(), by, note });
}

/**
 * POST /disputes/:id/messages { text, fileIds? } (buyer / seller staff) and
 * POST /admin/disputes/:id/messages (platform). A seller reply (or the requested party's reply)
 * moves the dispute to the review queue.
 */
export async function addMessage(req, id, { text, fileIds = [] }) {
  const { d, role } = await load(req, id);
  if (!OPEN_DISPUTE_STATUSES.includes(d.status)) throw new AppError(409, "This dispute is closed", "INVALID_STATE");
  const body = String(text || "").trim();
  const files = await checkFiles(fileIds, { role, userId: req.user._id, tenantId: d.tenantId });
  if (!body && !files.length) throw new AppError(400, "Write a message or attach a file", "VALIDATION_ERROR");
  const now = new Date();
  const set = {};
  const history = [];
  if (role === "seller" && ["open", "awaiting_seller"].includes(d.status)) {
    if (!d.sellerRespondedAt) set.sellerRespondedAt = now;
    moveToReview(set, history, { note: d.status === "open" ? "Seller responded" : "Seller sent the requested information", by: req.user._id });
  } else if (role === "buyer" && d.status === "awaiting_buyer") {
    moveToReview(set, history, { note: "Buyer sent the requested information", by: req.user._id });
  }
  const update = {
    $push: {
      messages: { from: role, userId: req.user._id, kind: "message", to: role === "admin" ? "both" : "", text: body.slice(0, 4000), fileIds: files, at: now },
      ...(history.length ? { history: { $each: history } } : {}),
    },
    ...(Object.keys(set).length ? { $set: set } : {}),
  };
  const updated = await Dispute.findOneAndUpdate({ _id: d._id, status: d.status }, update, { new: true });
  if (!updated) throw new AppError(409, "The dispute changed. Refresh and try again.", "INVALID_STATE");
  if (set.status) await syncOrder(updated);
  emitDomain("DISPUTE_MESSAGE", eventPayload(updated, { from: role, preview: body.slice(0, 200), files: files.length }));
  if (set.status === "under_review") emitDomain("DISPUTE_UNDER_REVIEW", eventPayload(updated, { timedOut: false }));
  return present(updated, role);
}

/** POST /disputes/:id/withdraw (buyer). */
export async function withdraw(req, id, { note = "" } = {}) {
  const { d, role } = await load(req, id);
  if (role !== "buyer") throw new AppError(403, "Only the buyer can withdraw a dispute", "FORBIDDEN");
  if (!OPEN_DISPUTE_STATUSES.includes(d.status)) throw new AppError(409, "This dispute is already closed", "INVALID_STATE");
  const now = new Date();
  const updated = await Dispute.findOneAndUpdate(
    { _id: d._id, status: { $in: OPEN_DISPUTE_STATUSES } },
    {
      $set: { status: "withdrawn", awaiting: "", respondBy: null, closedAt: now },
      $push: {
        history: { status: "withdrawn", at: now, by: req.user._id, note: String(note || "Withdrawn by the buyer").slice(0, 500) },
        messages: { from: "system", kind: "status", text: "The buyer withdrew the dispute.", at: now },
      },
    },
    { new: true }
  );
  if (!updated) throw new AppError(409, "This dispute is already closed", "INVALID_STATE");
  await syncOrder(updated);
  emitDomain("DISPUTE_WITHDRAWN", eventPayload(updated));
  return present(updated, role);
}

/* ------------------------------------------------------------------ admin */

/**
 * POST /admin/disputes/:id/request-info { from: buyer|seller, message } -> awaiting_buyer /
 * awaiting_seller with respondBy = now + disputes.sellerResponseHours (back to review on timeout).
 */
export async function requestInfo(req, id, { from, message }) {
  const { d } = await load(req, id);
  if (!OPEN_DISPUTE_STATUSES.includes(d.status)) throw new AppError(409, "This dispute is closed", "INVALID_STATE");
  const text = String(message || "").trim();
  if (!text) throw new AppError(400, "Say what information is needed", "VALIDATION_ERROR");
  const sla = await phase6Sla();
  const now = new Date();
  const status = from === "buyer" ? "awaiting_buyer" : "awaiting_seller";
  const respondBy = new Date(now.getTime() + sla.sellerResponseHours * HOUR);
  const updated = await Dispute.findOneAndUpdate(
    { _id: d._id, status: { $in: OPEN_DISPUTE_STATUSES } },
    {
      $set: { status, awaiting: from, respondBy },
      $push: {
        messages: { from: "admin", userId: req.user._id, kind: "info_request", to: from, text: text.slice(0, 4000), at: now },
        history: { status, at: now, by: req.user._id, note: `More information requested from the ${from}` },
      },
    },
    { new: true }
  );
  if (!updated) throw new AppError(409, "The dispute changed. Refresh and try again.", "INVALID_STATE");
  await syncOrder(updated);
  emitDomain("DISPUTE_INFO_REQUESTED", eventPayload(updated, { to: from, respondBy, preview: text.slice(0, 200) }));
  return present(updated, "admin");
}

const DECISION_STATUS = { refund: "resolved_refund", reopen: "resolved_reopened", reject: "rejected" };

/**
 * POST /admin/disputes/:id/decide { action: refund|reopen|reject, amount?, reason }.
 *  refund: forced refund of `amount` (default: the claim; <= still refundable) via the order's
 *          refund path (Razorpay / COD payout / ledger credit) + seller ledger debit + credit note;
 *  reopen: the disputed units get a new approved return (pickup booked again);
 *  reject: nothing changes on the order.
 * Money steps are idempotent per dispute; the status claim afterwards only matches an open dispute.
 */
export async function decide(req, id, { action, amount = null, reason }) {
  const { d } = await load(req, id);
  if (!OPEN_DISPUTE_STATUSES.includes(d.status)) throw new AppError(409, "This dispute is already decided", "INVALID_STATE");
  const why = String(reason || "").trim();
  if (why.length < 3) throw new AppError(400, "Give a reason for the decision", "VALIDATION_ERROR");
  const decision = { action, amount: 0, reason: why.slice(0, 2000), by: req.user._id, at: new Date(), refundKey: "", refundMethod: "", newReturnId: null };
  if (action === "refund") {
    const out = await refundForDispute(d.orderId, { returnId: d.returnId, disputeId: d._id, amount: amount ?? null, actorId: req.user._id, reason: why });
    decision.amount = out.refund.amount;
    decision.refundKey = out.refund.key;
    decision.refundMethod = out.refund.method || "";
  } else if (action === "reopen") {
    const out = await reopenReturnForDispute(d.orderId, { returnId: d.returnId, disputeId: d._id, actorId: req.user._id, note: `Reopened by the platform (dispute ${d.number}): ${why}` });
    decision.newReturnId = out.returnId;
  } else if (action !== "reject") {
    throw new AppError(400, "action must be refund, reopen or reject", "VALIDATION_ERROR");
  }
  const status = DECISION_STATUS[action];
  const now = new Date();
  const text =
    action === "refund"
      ? `Decision: refund of ₹${decision.amount.toFixed(2)}. ${why}`
      : action === "reopen"
        ? `Decision: the return is reopened and will be picked up again. ${why}`
        : `Decision: dispute rejected. ${why}`;
  const updated = await Dispute.findOneAndUpdate(
    { _id: d._id, status: { $in: OPEN_DISPUTE_STATUSES } },
    {
      $set: { status, decision, awaiting: "", respondBy: null, closedAt: now },
      $push: {
        messages: { from: "admin", userId: req.user._id, kind: "decision", to: "both", text: text.slice(0, 4000), at: now },
        history: { status, at: now, by: req.user._id, note: why.slice(0, 500) },
      },
    },
    { new: true }
  );
  if (!updated) throw new AppError(409, "The dispute was decided meanwhile. Refresh.", "INVALID_STATE");
  await syncOrder(updated);
  emitDomain("DISPUTE_DECIDED", eventPayload(updated, { action, amount: decision.amount, reason: why.slice(0, 300), refundMethod: decision.refundMethod }));
  return present(updated, "admin");
}

/* ------------------------------------------------------------------ evidence links */

/**
 * GET /disputes/:id/files/:fileId/link (and the admin twin): short-lived signed link for a file
 * attached to this dispute (messages) or a QC photo of its return. Both parties may open them.
 */
export async function fileLink(req, id, fileId) {
  const { d } = await load(req, id);
  const order = await Order.findById(d.orderId, "returns").lean();
  const ret = (order?.returns || []).find((r) => idStr(r._id) === idStr(d.returnId));
  const allowed = new Set([...(d.messages || []).flatMap((m) => (m.fileIds || []).map(String)), ...(ret?.qc?.photos || []).map(String)]);
  if (!allowed.has(String(fileId))) throw new AppError(404, "File not found", "NOT_FOUND");
  const row = await PrivateFile.findById(fileId).lean();
  if (!row) throw new AppError(404, "File not found", "NOT_FOUND");
  const { signPrivateFile } = await import("../files/routes.js");
  const exp = Math.floor(Date.now() / 1000) + 5 * 60;
  const sig = signPrivateFile(String(row._id), String(exp));
  return { url: `/api/v1/files/private/${row._id}?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000).toISOString(), file: fileMeta(row) };
}

/* ------------------------------------------------------------------ SLA job */

/**
 * Job `disputes-sla`: disputes whose awaited party (seller after opening / after an info request,
 * or the buyer after an info request) did not reply by `respondBy` go to the review queue anyway
 * (`timedOut`); admins are alerted (DISPUTE_UNDER_REVIEW).
 */
export async function runDisputesSla({ now = new Date(), limit = 200 } = {}) {
  const due = await Dispute.find({ status: { $in: ["open", "awaiting_seller", "awaiting_buyer"] }, respondBy: { $ne: null, $lte: now } })
    .sort({ respondBy: 1 })
    .limit(limit);
  let escalated = 0;
  for (const d of due) {
    const who = d.status === "awaiting_buyer" ? "buyer" : "seller";
    const set = {};
    const history = [];
    moveToReview(set, history, { note: `No reply from the ${who} in time`, timedOut: true });
    const updated = await Dispute.findOneAndUpdate(
      { _id: d._id, status: d.status, respondBy: d.respondBy },
      {
        $set: set,
        $push: { history: { $each: history }, messages: { from: "system", kind: "status", text: `The ${who} did not reply in time; the platform will review the dispute.`, at: now } },
      },
      { new: true }
    );
    if (!updated) continue;
    escalated += 1;
    await syncOrder(updated);
    emitDomain("DISPUTE_UNDER_REVIEW", eventPayload(updated, { timedOut: true, who }));
  }
  return { escalated };
}
