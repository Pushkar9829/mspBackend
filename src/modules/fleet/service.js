import crypto from "crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { Rider, DeliveryTask, DeliveryRun, RiderCashEntry, TERMINAL_TASK_STATUSES } from "./models.js";
import { fleetSettings } from "./settings.js";
import { normalizeRiderPhone, toPaise, mapUrl, sendFleetSms } from "./util.js";
import { User } from "../users/user.model.js";
import { Role } from "../rbac/role.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { Order } from "../orders/order.model.js";
import { PrivateFile } from "../files/privateFile.model.js";
import { advanceOrder, markRtoInTransit, returnToOrigin, transition, markReturnPickupFailed } from "../orders/lifecycle.js";
import { assertWithinLimit } from "../billing/entitlements.js";
import { encryptSecret, decryptSecret, hashSecret } from "../sellerApplications/crypto.js";
import { loadUserRefs, userRef } from "../../utils/userRefs.js";
import { createQrCode, fetchQrPayments, razorpayConfigured } from "../checkout/razorpayApi.js";
import { SALT, bumpTokenVersion } from "../auth/service.js";
import { AppError } from "../../utils/AppError.js";
import { emitDomain } from "../../utils/events.js";
import { logger } from "../../utils/logger.js";
import { env } from "../../config/env.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { dayKey, startOfDay, addDays, endOfDay } from "../reports/time.js";
import { SYSTEM_ROLES, DELIVERY_FAIL_REASONS } from "../../config/constants.js";

/**
 * Own delivery fleet (phase 5, p5-backend): riders, delivery board, rider app flows, rider cash.
 * Routes: fleet/routes.js. Order lifecycle hooks: fleet/hooks.js.
 */

const OPEN_STATUSES = ["assigned", "accepted", "picked_up", "out_for_delivery", "failed", "returning"];
/** Waiting for a rider on the board: unassigned, or a failed attempt sent back to the pool. */
const POOL_FILTER = { $or: [{ status: "unassigned" }, { status: "failed", riderId: null }] };
const IN_PROGRESS = ["picked_up", "out_for_delivery", "delivered", "failed", "returning", "returned_to_store"];
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_RESENDS = 5;
const QR_TTL_SECONDS = 2 * 60 * 60;

export const TASK_STATUS_LABELS = {
  unassigned: "Waiting for a rider",
  assigned: "Assigned",
  accepted: "Accepted",
  picked_up: "Picked up",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  failed: "Attempt failed",
  returning: "Returning to store",
  returned_to_store: "Returned to store",
  cancelled: "Cancelled",
};
export const FAIL_REASON_LABELS = {
  buyer_unavailable: "Buyer not available",
  address_not_found: "Address not found",
  buyer_refused: "Buyer refused the order",
  cash_not_ready: "Buyer did not have the cash",
  other: "Other",
};

const idOf = (v) => v?._id || v || null;
const sameId = (a, b) => Boolean(a) && Boolean(b) && String(idOf(a)) === String(idOf(b));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function oid(value, what = "id") {
  if (!mongoose.isValidObjectId(String(value || ""))) throw new AppError(400, `Invalid ${what}`, "INVALID_ID");
  return new mongoose.Types.ObjectId(String(value));
}

function tenantOf(req) {
  const id = req.tenantId || idOf(req.user?.tenantId);
  if (!id) throw new AppError(400, "Tenant context required (X-Tenant-Id)", "TENANT_REQUIRED");
  return id;
}

function validDay(value, fallback = dayKey()) {
  if (value === undefined || value === null || value === "") return fallback;
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(startOfDay(s).getTime())) {
    throw new AppError(400, "date must be YYYY-MM-DD", "VALIDATION_ERROR", { fields: { date: "Use YYYY-MM-DD" } });
  }
  return s;
}

let riderRoleCache = null;
export async function riderRole() {
  if (riderRoleCache) return riderRoleCache;
  const role = await Role.findOne({ slug: SYSTEM_ROLES.RIDER, isSystem: true });
  if (!role) throw new AppError(500, "Rider role not seeded", "SERVER_ERROR");
  riderRoleCache = role;
  return role;
}

/* ================================================================== presenters */

async function cashBalances(tenantId, riderIds = null) {
  const match = { tenantId: idOf(tenantId) };
  if (riderIds) match.riderId = { $in: riderIds.map(idOf) };
  const rows = await RiderCashEntry.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$riderId",
        balance: { $sum: "$amountPaise" },
        collected: { $sum: { $cond: [{ $eq: ["$kind", "collected"] }, "$amountPaise", 0] } },
        deposited: { $sum: { $cond: [{ $eq: ["$kind", "deposit"] }, { $multiply: ["$amountPaise", -1] }, 0] } },
        lastCollectedAt: { $max: { $cond: [{ $eq: ["$kind", "collected"] }, "$at", null] } },
        lastDepositAt: { $max: { $cond: [{ $eq: ["$kind", "deposit"] }, "$at", null] } },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

async function openTaskCounts(tenantId, riderIds) {
  const rows = await DeliveryTask.aggregate([
    { $match: { tenantId: idOf(tenantId), riderId: { $in: riderIds.map(idOf) }, status: { $in: OPEN_STATUSES } } },
    { $group: { _id: "$riderId", n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

export function presentRider(rider, { cash = null, openTasks = undefined } = {}) {
  if (!rider) return null;
  const r = typeof rider.toObject === "function" ? rider.toObject() : rider;
  const out = {
    id: r._id,
    tenantId: r.tenantId,
    userId: r.userId,
    name: r.name,
    phone: r.phone,
    vehicle: { type: r.vehicle?.type || "bike", number: r.vehicle?.number || "" },
    idProof: { type: r.idProof?.type || "", last4: r.idProof?.last4 || "", fileId: r.idProof?.fileId || null },
    status: r.status,
    zoneNames: r.zoneNames || [],
    stats: { delivered: r.stats?.delivered || 0, failed: r.stats?.failed || 0 },
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
  if (cash !== null) out.cashInHandPaise = cash?.balance || 0;
  if (openTasks !== undefined) out.openTasks = openTasks;
  return out;
}

function riderBrief(rider) {
  return rider ? { id: rider._id, name: rider.name, phone: rider.phone, vehicle: rider.vehicle || null } : null;
}

/**
 * Task as returned by the API. `otp` never carries the code (only sent / attempts / verified);
 * riders get no seller-only fields (history actors are ids only anyway).
 */
export function presentTask(task, { rider = null, order = null } = {}) {
  if (!task) return null;
  const t = typeof task.toObject === "function" ? task.toObject() : task;
  const out = {
    id: t._id,
    tenantId: t.tenantId,
    orderId: t.orderId,
    orderNumber: t.orderNumber,
    kind: t.kind,
    returnId: t.returnId || null,
    status: t.status,
    statusLabel: TASK_STATUS_LABELS[t.status] || t.status,
    area: t.area || "",
    dueDate: t.dueDate || "",
    riderId: t.riderId || null,
    rider: riderBrief(rider),
    runId: t.runId || null,
    attempts: (t.attempts || []).map((a) => ({
      at: a.at,
      reason: a.reason,
      reasonLabel: FAIL_REASON_LABELS[a.reason] || a.reason,
      note: a.note || "",
      photoFileId: a.photoFileId || null,
    })),
    attemptsCount: (t.attempts || []).length,
    maxAttempts: t.maxAttempts || 2,
    rescheduledFor: t.rescheduledFor || null,
    otp: {
      sent: Boolean(t.otp?.sentAt),
      sentAt: t.otp?.sentAt || null,
      attempts: t.otp?.attempts || 0,
      resends: t.otp?.resends || 0,
      // When the rider may tap "Resend code" again (30 s cooldown after each send).
      resendAvailableAt: t.otp?.sentAt ? new Date(new Date(t.otp.sentAt).getTime() + OTP_RESEND_COOLDOWN_MS) : null,
      verified: Boolean(t.otp?.verifiedAt),
      verifiedAt: t.otp?.verifiedAt || null,
    },
    cod: {
      amount: t.cod?.amount || 0,
      amountPaise: toPaise(t.cod?.amount || 0),
      method: t.cod?.method || null,
      collected: Boolean(t.cod?.collectedAt),
      collectedAt: t.cod?.collectedAt || null,
      qr: t.cod?.razorpayQrId ? { id: t.cod.razorpayQrId, imageUrl: t.cod.qrImageUrl || "", amountPaise: t.cod.qrAmountPaise || 0 } : null,
      paidByUpi: Boolean(t.cod?.paidAt),
      paidAt: t.cod?.paidAt || null,
      razorpayPaymentId: t.cod?.razorpayPaymentId || "",
    },
    proofPhotoFileId: t.proofPhotoFileId || null,
    itemCheck: t.itemCheck || [],
    photos: t.photos || [],
    dropoff: { ...(t.dropoff || {}), mapUrl: mapUrl(t.dropoff || {}) },
    buyer: t.buyer || { name: "", phone: "" },
    assignedAt: t.assignedAt || null,
    completedAt: t.completedAt || null,
    history: t.history || [],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
  if (order) {
    out.order = {
      id: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      total: order.total,
      items: (order.items || []).map((i) => ({ id: i._id, name: i.name, sku: i.sku, qty: i.qty, image: i.image || "" })),
    };
    if (t.kind === "return_pickup") {
      const ret = (order.returns || []).find((r) => sameId(r._id, t.returnId));
      out.returnItems = (ret?.items || []).map((i) => ({ itemId: i.itemId, name: i.name, qty: i.qty }));
      out.returnReason = ret?.reason || "";
    }
  }
  return out;
}

async function presentTasks(tasks, { withOrders = false } = {}) {
  const riderIds = [...new Set(tasks.map((t) => t.riderId).filter(Boolean).map(String))];
  const riders = riderIds.length ? await Rider.find({ _id: { $in: riderIds } }).lean() : [];
  const riderById = new Map(riders.map((r) => [String(r._id), r]));
  let orderById = new Map();
  if (withOrders) {
    const orders = await Order.find({ _id: { $in: tasks.map((t) => t.orderId) } }).select("orderNumber status paymentMethod paymentStatus total items returns").lean();
    orderById = new Map(orders.map((o) => [String(o._id), o]));
  }
  return tasks.map((t) => presentTask(t, { rider: riderById.get(String(t.riderId)) || null, order: orderById.get(String(t.orderId)) || null }));
}

/* ================================================================== riders (seller) */

async function assertPrivateFile(tenantId, fileId, { uploadedBy = null, folders = null } = {}) {
  if (!fileId) return null;
  const id = oid(fileId, "fileId");
  const row = await PrivateFile.findOne({ _id: id, tenantId: idOf(tenantId) }).lean();
  if (!row || (uploadedBy && !sameId(row.uploadedBy, uploadedBy)) || (folders && !folders.includes(row.folder))) {
    throw new AppError(400, "File not found (upload it first via POST /files/private)", "VALIDATION_ERROR", { fields: { fileId: "Unknown file" } });
  }
  return row._id;
}

function idProofPatch(idProof = {}) {
  const number = String(idProof.number || "").replace(/\s+/g, "").toUpperCase();
  const patch = { type: idProof.type || "" };
  if (number) {
    patch.last4 = number.slice(-4);
    patch.numberHash = hashSecret(`rider-id:${patch.type}:${number}`);
  }
  return patch;
}

async function loadRider(req, id) {
  const rider = await Rider.findOne({ _id: oid(id, "rider id"), tenantId: tenantOf(req) });
  if (!rider) throw new AppError(404, "Rider not found", "NOT_FOUND");
  return rider;
}

export async function listRiders(req) {
  const tenantId = tenantOf(req);
  const { page, limit, skip } = paginate(req.query);
  const filter = { tenantId };
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: rx }, { phone: rx }, { "vehicle.number": rx }];
  }
  const [rows, total] = await Promise.all([
    Rider.find(filter).sort({ status: 1, name: 1 }).skip(skip).limit(limit).lean(),
    Rider.countDocuments(filter),
  ]);
  const ids = rows.map((r) => r._id);
  const [cash, open] = await Promise.all([cashBalances(tenantId, ids), openTaskCounts(tenantId, ids)]);
  return paginated(rows.map((r) => presentRider(r, { cash: cash.get(String(r._id)) || { balance: 0 }, openTasks: open.get(String(r._id)) || 0 })), total, { page, limit });
}

export async function getRider(req, id) {
  const rider = await loadRider(req, id);
  const [cash, open] = await Promise.all([cashBalances(rider.tenantId, [rider._id]), openTaskCounts(rider.tenantId, [rider._id])]);
  return presentRider(rider, { cash: cash.get(String(rider._id)) || { balance: 0 }, openTasks: open.get(String(rider._id)) || 0 });
}

function phoneOrThrow(raw) {
  const phone = normalizeRiderPhone(raw);
  if (!phone) throw new AppError(400, "Enter a valid 10-digit Indian mobile number", "VALIDATION_ERROR", { fields: { phone: "Invalid mobile number" } });
  return phone;
}

/**
 * Add a rider: a User with the system rider role (synthetic non-deliverable email
 * rider+<userId>@riders.invalid, random unusable password; riders log in with mobile + OTP) and
 * the Rider profile. Counts against the plan's `riders` limit.
 */
export async function createRider(req, body) {
  const tenantId = tenantOf(req);
  const phone = phoneOrThrow(body.phone);
  if (await Rider.exists({ phone })) throw new AppError(409, "A rider with this mobile number already exists", "DUPLICATE", { fields: { phone: "Already a rider" } });
  await assertWithinLimit(tenantId, "riders", { req });
  const fileId = await assertPrivateFile(tenantId, body.idProof?.fileId);
  const role = await riderRole();
  const userId = new mongoose.Types.ObjectId();
  const user = await User.create({
    _id: userId,
    name: body.name,
    email: `rider+${userId}@riders.invalid`,
    phone,
    passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), SALT),
    tenantId,
    roleId: role._id,
    status: "active",
    emailVerified: false,
  });
  try {
    const rider = await Rider.create({
      tenantId,
      userId: user._id,
      name: body.name,
      phone,
      vehicle: { type: body.vehicle?.type || "bike", number: body.vehicle?.number || "" },
      idProof: { ...idProofPatch(body.idProof || {}), fileId },
      zoneNames: body.zoneNames || [],
      status: "active",
      createdBy: req.user?._id || null,
    });
    emitDomain("RIDER_CREATED", { tenantId, riderId: rider._id, userId: user._id, resource: "rider", resourceId: rider._id });
    return presentRider(rider, { cash: { balance: 0 }, openTasks: 0 });
  } catch (err) {
    await User.deleteOne({ _id: user._id }).catch(() => {});
    if (err?.code === 11000) throw new AppError(409, "A rider with this mobile number already exists", "DUPLICATE");
    throw err;
  }
}

export async function updateRider(req, id, body) {
  const rider = await loadRider(req, id);
  const userSet = {};
  if (body.name !== undefined) {
    rider.name = body.name;
    userSet.name = body.name;
  }
  if (body.phone !== undefined) {
    const phone = phoneOrThrow(body.phone);
    if (phone !== rider.phone) {
      if (await Rider.exists({ phone, _id: { $ne: rider._id } })) throw new AppError(409, "A rider with this mobile number already exists", "DUPLICATE");
      rider.phone = phone;
      userSet.phone = phone;
    }
  }
  if (body.vehicle) {
    if (body.vehicle.type !== undefined) rider.set("vehicle.type", body.vehicle.type);
    if (body.vehicle.number !== undefined) rider.set("vehicle.number", body.vehicle.number);
  }
  if (body.idProof) {
    const patch = idProofPatch({ type: body.idProof.type ?? rider.idProof?.type, number: body.idProof.number });
    rider.set("idProof.type", patch.type);
    if (patch.last4) {
      rider.set("idProof.last4", patch.last4);
      rider.set("idProof.numberHash", patch.numberHash);
    }
    if (body.idProof.fileId !== undefined) rider.set("idProof.fileId", body.idProof.fileId ? await assertPrivateFile(rider.tenantId, body.idProof.fileId) : null);
  }
  if (body.zoneNames !== undefined) rider.zoneNames = body.zoneNames;
  try {
    await rider.save();
  } catch (err) {
    if (err?.code === 11000) throw new AppError(409, "A rider with this mobile number already exists", "DUPLICATE");
    throw err;
  }
  if (Object.keys(userSet).length) await User.updateOne({ _id: rider.userId }, { $set: userSet });
  return getRider(req, rider._id);
}

/**
 * Deactivate: the rider can no longer log in (all sessions revoked); deliveries not yet picked up
 * go back to the unassigned list. Activate: counts against the plan's `riders` limit.
 */
export async function setRiderStatus(req, id, status) {
  const rider = await loadRider(req, id);
  if (rider.status === status) return getRider(req, rider._id);
  if (status === "active") {
    await assertWithinLimit(rider.tenantId, "riders", { req });
    rider.status = "active";
    await rider.save();
    await User.updateOne({ _id: rider.userId, status: { $ne: "deleted" } }, { $set: { status: "active" } });
  } else {
    rider.status = "inactive";
    await rider.save();
    await User.updateOne({ _id: rider.userId, status: { $ne: "deleted" } }, { $set: { status: "suspended" } });
    await bumpTokenVersion(rider.userId, "rider_deactivated");
    const back = await DeliveryTask.find({ riderId: rider._id, status: { $in: ["assigned", "accepted"] } }).select("_id runId").lean();
    for (const t of back) {
      await DeliveryTask.updateOne(
        { _id: t._id, status: { $in: ["assigned", "accepted"] } },
        {
          $set: { status: "unassigned", riderId: null, runId: null, assignedAt: null },
          $push: { history: { at: new Date(), from: "", to: "unassigned", by: req.user?._id || null, note: "Rider deactivated" } },
        }
      );
      if (t.runId) await DeliveryRun.updateOne({ _id: t.runId }, { $pull: { taskIds: t._id } });
    }
  }
  return getRider(req, rider._id);
}

/* ================================================================== rider cash */

export async function cashOverview(req) {
  const tenantId = tenantOf(req);
  const riders = await Rider.find({ tenantId }).sort({ status: 1, name: 1 }).lean();
  const cash = await cashBalances(tenantId);
  const rows = riders.map((r) => {
    const c = cash.get(String(r._id));
    return {
      rider: presentRider(r),
      cashInHandPaise: c?.balance || 0,
      collectedPaise: c?.collected || 0,
      depositedPaise: c?.deposited || 0,
      lastCollectedAt: c?.lastCollectedAt || null,
      lastDepositAt: c?.lastDepositAt || null,
    };
  });
  return { data: rows, totalCashInHandPaise: rows.reduce((s, r) => s + r.cashInHandPaise, 0) };
}

function presentCashEntry(e) {
  return {
    id: e._id,
    riderId: e.riderId,
    kind: e.kind,
    amountPaise: e.amountPaise,
    taskId: e.taskId || null,
    orderId: e.orderId || null,
    orderNumber: e.orderNumber || "",
    note: e.note || "",
    by: e.by || null,
    at: e.at,
  };
}

async function cashHistory(rider, query = {}) {
  const { page, limit, skip } = paginate(query);
  const filter = { riderId: rider._id };
  const [rows, total, bal] = await Promise.all([
    RiderCashEntry.find(filter).sort({ at: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    RiderCashEntry.countDocuments(filter),
    cashBalances(rider.tenantId, [rider._id]),
  ]);
  const c = bal.get(String(rider._id));
  return {
    rider: presentRider(rider),
    cashInHandPaise: c?.balance || 0,
    collectedPaise: c?.collected || 0,
    depositedPaise: c?.deposited || 0,
    ...paginated(rows.map(presentCashEntry), total, { page, limit }),
  };
}

export async function riderCash(req, id) {
  return cashHistory(await loadRider(req, id), req.query);
}

/** The store confirms it received `amount` (rupees) of COD cash from the rider. */
export async function addDeposit(req, id, { amount, note = "" }) {
  const rider = await loadRider(req, id);
  const paise = toPaise(amount);
  if (!(paise > 0)) throw new AppError(400, "Amount must be more than zero", "VALIDATION_ERROR", { fields: { amount: "Must be > 0" } });
  const bal = (await cashBalances(rider.tenantId, [rider._id])).get(String(rider._id))?.balance || 0;
  if (paise > bal) {
    throw new AppError(409, `The rider holds only ₹${(bal / 100).toFixed(2)} in cash`, "CASH_EXCEEDS_BALANCE", { cashInHandPaise: bal });
  }
  const entry = await RiderCashEntry.create({
    tenantId: rider.tenantId,
    riderId: rider._id,
    kind: "deposit",
    amountPaise: -paise,
    note: String(note || "").slice(0, 300),
    by: req.user?._id || null,
    at: new Date(),
  });
  emitDomain("RIDER_CASH_DEPOSITED", { tenantId: rider.tenantId, riderId: rider._id, amountPaise: paise, resource: "rider", resourceId: rider._id });
  return { entry: presentCashEntry(entry), cashInHandPaise: bal - paise };
}

/* ================================================================== runs */

async function attachToRun(task, riderId, date) {
  const run = await DeliveryRun.findOneAndUpdate(
    { tenantId: task.tenantId, riderId, date, area: task.area || "" },
    { $addToSet: { taskIds: task._id }, $setOnInsert: { status: "open" } },
    { upsert: true, new: true }
  );
  if (task.runId && !sameId(task.runId, run._id)) {
    await DeliveryRun.updateOne({ _id: task.runId }, { $pull: { taskIds: task._id } });
    await recomputeRun(task.runId);
  }
  if (!sameId(task.runId, run._id)) await DeliveryTask.updateOne({ _id: task._id }, { $set: { runId: run._id } });
  task.runId = run._id;
  await recomputeRun(run._id);
  return run;
}

async function detachFromRun(task) {
  if (!task.runId) return;
  await DeliveryRun.updateOne({ _id: task.runId }, { $pull: { taskIds: task._id } });
  await recomputeRun(task.runId);
}

async function recomputeRun(runId) {
  if (!runId) return;
  const run = await DeliveryRun.findById(runId).lean();
  if (!run) return;
  const tasks = await DeliveryTask.find({ _id: { $in: run.taskIds } }).select("status").lean();
  let status = "open";
  if (tasks.length && tasks.every((t) => TERMINAL_TASK_STATUSES.includes(t.status))) status = "done";
  else if (tasks.some((t) => IN_PROGRESS.includes(t.status))) status = "in_progress";
  if (status !== run.status) await DeliveryRun.updateOne({ _id: run._id }, { $set: { status } });
}

/* ================================================================== task state */

function hist(from, to, by, note = "") {
  return { at: new Date(), from, to, by: by || null, note: String(note || "").slice(0, 500) };
}

/** Conditional status move: `{ _id, status ∈ from, ...filter }` -> `to`. 409 when the task changed. */
async function moveTask(task, from, to, { by = null, note = "", set = {}, push = {}, unset = null, filter = {} } = {}) {
  const fromList = Array.isArray(from) ? from : [from];
  const update = { $set: { status: to, ...set }, $push: { history: hist(task.status, to, by, note), ...push } };
  if (unset) update.$unset = unset;
  const updated = await DeliveryTask.findOneAndUpdate({ _id: task._id, status: { $in: fromList }, ...filter }, update, { new: true });
  if (!updated) {
    const current = await DeliveryTask.findById(task._id).select("status").lean();
    if (!current) throw new AppError(404, "Delivery not found", "NOT_FOUND");
    throw new AppError(409, `This delivery is ${TASK_STATUS_LABELS[current.status] || current.status}. Refresh and try again.`, "INVALID_STATE", { status: current.status });
  }
  return updated;
}

async function loadTaskForStore(req, id) {
  const task = await DeliveryTask.findOne({ _id: oid(id, "task id"), tenantId: tenantOf(req) });
  if (!task) throw new AppError(404, "Delivery not found", "NOT_FOUND");
  return task;
}

async function activeRiderOf(tenantId, riderId) {
  const rider = await Rider.findOne({ _id: oid(riderId, "riderId"), tenantId: idOf(tenantId) });
  if (!rider) throw new AppError(404, "Rider not found", "NOT_FOUND");
  if (rider.status !== "active") throw new AppError(409, "This rider is inactive", "RIDER_INACTIVE");
  return rider;
}

async function orderFor(task) {
  const order = await Order.findById(task.orderId);
  if (!order) throw new AppError(404, "Order not found", "NOT_FOUND");
  return order;
}

/** Assign (or reassign) a task to an active rider; it joins the rider's run for its day + area. */
async function assignInternal(task, rider, { actorId = null, note = "" } = {}) {
  const today = dayKey();
  const date = task.dueDate && task.dueDate > today ? task.dueDate : today;
  const from = ["unassigned", "assigned", "accepted", "failed"];
  if (task.status === "failed" && task.kind === "delivery") {
    const order = await Order.findById(task.orderId).select("status").lean();
    if (!["shipped", "ready_to_ship"].includes(order?.status)) {
      throw new AppError(409, "This delivery can no longer be assigned", "INVALID_STATE");
    }
  }
  const updated = await moveTask(task, from, "assigned", {
    by: actorId,
    note: note || `Assigned to ${rider.name}`,
    set: { riderId: rider._id, assignedAt: new Date(), dueDate: date },
  });
  await attachToRun(updated, rider._id, date);
  if (!sameId(task.riderId, rider._id) || task.status !== "assigned") {
    emitDomain("RIDER_ASSIGNED", {
      tenantId: updated.tenantId,
      riderId: rider._id,
      riderUserId: rider.userId,
      taskId: updated._id,
      orderId: updated.orderId,
      orderNumber: updated.orderNumber,
      kind: updated.kind,
      resource: "delivery_task",
      resourceId: updated._id,
    });
  }
  return DeliveryTask.findById(updated._id);
}

/* ================================================================== seller: board + tasks */

export async function board(req) {
  const tenantId = tenantOf(req);
  const date = validDay(req.query.date);
  const [pool, riders] = await Promise.all([
    DeliveryTask.find({ tenantId, ...POOL_FILTER, $and: [{ $or: [{ dueDate: { $lte: date } }, { dueDate: "" }] }] }).sort({ createdAt: 1 }).limit(500).lean(),
    Rider.find({ tenantId }).sort({ name: 1 }).lean(),
  ]);
  const runs = await DeliveryRun.find({ tenantId, date }).lean();
  const openTasks = await DeliveryTask.find({ tenantId, riderId: { $in: riders.map((r) => r._id) }, status: { $in: OPEN_STATUSES } }).lean();
  const runTaskIds = runs.flatMap((r) => r.taskIds);
  const runTasks = runTaskIds.length ? await DeliveryTask.find({ _id: { $in: runTaskIds } }).lean() : [];
  const presented = await presentTasks([...pool, ...openTasks, ...runTasks]);
  const byId = new Map(presented.map((t) => [String(t.id), t]));
  const cash = await cashBalances(tenantId);

  const areas = new Map();
  for (const t of pool) {
    const key = t.area || "Other";
    if (!areas.has(key)) areas.set(key, []);
    areas.get(key).push(byId.get(String(t._id)));
  }
  const ridersOut = riders
    .map((r) => {
      const mine = openTasks.filter((t) => sameId(t.riderId, r._id));
      const myRuns = runs
        .filter((run) => sameId(run.riderId, r._id))
        .map((run) => ({
          id: run._id,
          date: run.date,
          area: run.area,
          status: run.status,
          tasks: run.taskIds.map((tid) => byId.get(String(tid))).filter(Boolean),
        }));
      const inRuns = new Set(myRuns.flatMap((run) => run.tasks.map((t) => String(t.id))));
      return {
        rider: presentRider(r),
        cashInHandPaise: cash.get(String(r._id))?.balance || 0,
        openTasks: mine.length,
        runs: myRuns,
        otherOpenTasks: mine.filter((t) => !inRuns.has(String(t._id))).map((t) => byId.get(String(t._id))),
      };
    })
    .filter((row) => row.rider.status === "active" || row.openTasks > 0 || row.runs.length);
  const dayStart = startOfDay(date);
  const dayEnd = endOfDay(date);
  const [deliveredToday, returning] = await Promise.all([
    DeliveryTask.countDocuments({ tenantId, status: "delivered", completedAt: { $gte: dayStart, $lte: dayEnd } }),
    DeliveryTask.countDocuments({ tenantId, status: "returning" }),
  ]);
  return {
    date,
    unassigned: [...areas.entries()].map(([area, tasks]) => ({ area, count: tasks.length, tasks })).sort((a, b) => b.count - a.count || a.area.localeCompare(b.area)),
    riders: ridersOut,
    counts: {
      unassigned: pool.length,
      assigned: openTasks.filter((t) => ["assigned", "accepted"].includes(t.status)).length,
      inProgress: openTasks.filter((t) => ["picked_up", "out_for_delivery"].includes(t.status)).length,
      failed: openTasks.filter((t) => t.status === "failed").length + pool.filter((t) => t.status === "failed").length,
      returning,
      deliveredToday,
    },
  };
}

export async function getTask(req, id) {
  const task = await loadTaskForStore(req, id);
  const [presented] = await presentTasks([task], { withOrders: true });
  const run = task.runId ? await DeliveryRun.findById(task.runId).lean() : null;
  // "by" ids -> { id, name, email } so the timeline shows whether the rider or the store acted.
  const refs = await loadUserRefs((presented.history || []).map((h) => h.by));
  const history = (presented.history || []).map((h) => ({ ...h, by: userRef(h.by, refs) }));
  return { ...presented, history, run: run ? { id: run._id, date: run.date, area: run.area, status: run.status } : null };
}

export async function assignTask(req, id, { riderId }) {
  const task = await loadTaskForStore(req, id);
  const rider = await activeRiderOf(task.tenantId, riderId);
  await assignInternal(task, rider, { actorId: req.user?._id });
  return getTask(req, task._id);
}

export async function unassignTask(req, id) {
  const task = await loadTaskForStore(req, id);
  const updated = await moveTask(task, ["assigned", "accepted", "failed"], "unassigned", {
    by: req.user?._id,
    note: "Unassigned by the store",
    set: { riderId: null, runId: null, assignedAt: null },
  });
  await detachFromRun(task);
  return getTask(req, updated._id);
}

export async function rescheduleTask(req, id, { date, note = "" }) {
  const task = await loadTaskForStore(req, id);
  const day = validDay(date);
  if (day < dayKey()) throw new AppError(400, "Pick today or a later day", "VALIDATION_ERROR", { fields: { date: "In the past" } });
  const allowed = ["unassigned", "assigned", "accepted", "failed"];
  if (!allowed.includes(task.status)) throw new AppError(409, `This delivery is ${TASK_STATUS_LABELS[task.status]} and cannot be rescheduled`, "INVALID_STATE");
  const updated = await DeliveryTask.findOneAndUpdate(
    { _id: task._id, status: { $in: allowed } },
    { $set: { dueDate: day, rescheduledFor: startOfDay(day) }, $push: { history: hist(task.status, task.status, req.user?._id, note || `Rescheduled to ${day}`) } },
    { new: true }
  );
  if (!updated) throw new AppError(409, "This delivery changed. Refresh and try again.", "INVALID_STATE");
  if (updated.riderId) await attachToRun(updated, updated.riderId, day);
  return getTask(req, updated._id);
}

/**
 * Cancel a task. A delivery task can be cancelled only before pickup; the order then leaves the
 * own fleet (deliveryMethod -> partner) so the store can ship it another way (courier / manual).
 */
export async function cancelTask(req, id, { note = "" } = {}) {
  const task = await loadTaskForStore(req, id);
  const updated = await moveTask(task, ["unassigned", "assigned", "accepted", "failed"], "cancelled", {
    by: req.user?._id,
    note: note || "Cancelled by the store",
    set: { completedAt: new Date() },
  });
  await detachFromRun(task);
  if (task.kind === "delivery") {
    const res = await Order.updateOne(
      { _id: task.orderId, deliveryMethod: "own_fleet" },
      {
        $set: { deliveryMethod: "partner" },
        $push: { statusHistory: { status: (await Order.findById(task.orderId).select("status").lean())?.status || "", actorId: req.user?._id || null, note: "Own-rider delivery cancelled; ship this order another way", at: new Date() } },
      }
    );
    // Tell the buyer the order now comes another way (no action needed from them).
    if (res.modifiedCount) {
      const order = await Order.findById(task.orderId).select("tenantId buyerId orderNumber status paymentMethod total").lean();
      if (order && !["cancelled", "delivered"].includes(order.status)) {
        emitDomain("DELIVERY_METHOD_CHANGED", {
          order: { _id: order._id, tenantId: order.tenantId, buyerId: order.buyerId, orderNumber: order.orderNumber, status: order.status, paymentMethod: order.paymentMethod, total: order.total, grandTotal: order.total },
          orderId: order._id,
          tenantId: order.tenantId,
          resource: "order",
          resourceId: order._id,
        });
      }
    }
  }
  return getTask(req, updated._id);
}

/**
 * Auto-assign the store's waiting tasks due on/before `date`: grouped by area, each area goes to
 * the active rider with the fewest open tasks among those serving it (riders with zoneNames only
 * take those areas; riders without zoneNames take any).
 */
export async function autoAssignTenant(tenantId, { date = dayKey(), actorId = null } = {}) {
  const pool = await DeliveryTask.find({ tenantId, ...POOL_FILTER, $and: [{ $or: [{ dueDate: { $lte: date } }, { dueDate: "" }] }] }).sort({ createdAt: 1 }).limit(500);
  const riders = await Rider.find({ tenantId, status: "active" }).lean();
  const result = { date, assigned: 0, skipped: [], assignments: [] };
  if (!pool.length) return result;
  if (!riders.length) {
    result.skipped = pool.map((t) => ({ taskId: t._id, area: t.area, reason: "No active riders" }));
    return result;
  }
  const open = await openTaskCounts(tenantId, riders.map((r) => r._id));
  const load = new Map(riders.map((r) => [String(r._id), open.get(String(r._id)) || 0]));
  const byArea = new Map();
  for (const t of pool) {
    const key = t.area || "Other";
    if (!byArea.has(key)) byArea.set(key, []);
    byArea.get(key).push(t);
  }
  const areas = [...byArea.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [area, tasks] of areas) {
    const candidates = riders.filter((r) => !(r.zoneNames || []).length || r.zoneNames.includes(area));
    if (!candidates.length) {
      for (const t of tasks) result.skipped.push({ taskId: t._id, area, reason: "No rider serves this area" });
      continue;
    }
    candidates.sort((a, b) => {
      const zoneA = (a.zoneNames || []).includes(area) ? 0 : 1;
      const zoneB = (b.zoneNames || []).includes(area) ? 0 : 1;
      return load.get(String(a._id)) - load.get(String(b._id)) || zoneA - zoneB || a.name.localeCompare(b.name);
    });
    const pick = candidates[0];
    for (const t of tasks) {
      try {
        await assignInternal(t, pick, { actorId, note: `Auto-assigned to ${pick.name}` });
        load.set(String(pick._id), load.get(String(pick._id)) + 1);
        result.assigned += 1;
        result.assignments.push({ taskId: t._id, riderId: pick._id, area });
      } catch (err) {
        result.skipped.push({ taskId: t._id, area, reason: err.message });
      }
    }
  }
  return result;
}

export async function autoAssign(req, { date } = {}) {
  return autoAssignTenant(tenantOf(req), { date: validDay(date), actorId: req.user?._id || null });
}

/* ================================================================== rider app */

/** The calling rider (system rider role + active profile of the user's store). */
export async function loadMe(req) {
  if (req.role?.slug !== SYSTEM_ROLES.RIDER || !req.role?.isSystem) throw new AppError(403, "Rider app only", "FORBIDDEN");
  const rider = await Rider.findOne({ userId: req.user._id, tenantId: idOf(req.user.tenantId) });
  if (!rider) throw new AppError(403, "No rider profile on this account", "FORBIDDEN");
  if (rider.status !== "active") throw new AppError(403, "Your rider account is inactive. Contact the store.", "RIDER_INACTIVE");
  return rider;
}

async function loadMyTask(req, id, { otp = false } = {}) {
  const rider = await loadMe(req);
  const q = DeliveryTask.findOne({ _id: oid(id, "task id"), tenantId: rider.tenantId, riderId: rider._id });
  if (otp) q.select("+otp.hash +otp.cipher");
  const task = await q;
  // Other riders' tasks look like they do not exist.
  if (!task) throw new AppError(404, "Delivery not found", "NOT_FOUND");
  return { rider, task };
}

export async function riderMe(req) {
  const rider = await loadMe(req);
  const tenant = await Tenant.findById(rider.tenantId).select("name slug status pickupAddress businessProfile.phone branding.logo").lean();
  const today = dayKey();
  const [cash, open, deliveredToday] = await Promise.all([
    cashBalances(rider.tenantId, [rider._id]),
    DeliveryTask.countDocuments({ riderId: rider._id, status: { $in: OPEN_STATUSES } }),
    DeliveryTask.countDocuments({ riderId: rider._id, status: "delivered", completedAt: { $gte: startOfDay(today), $lte: endOfDay(today) } }),
  ]);
  const pa = tenant?.pickupAddress || {};
  return {
    rider: presentRider(rider),
    store: tenant
      ? {
          id: tenant._id,
          name: tenant.name,
          slug: tenant.slug,
          status: tenant.status,
          logo: tenant.branding?.logo || "",
          phone: tenant.businessProfile?.phone || pa.phone || "",
          address: [pa.addressLine1, pa.addressLine2, pa.city, pa.state, pa.postalCode].filter(Boolean).join(", "),
        }
      : null,
    cashInHandPaise: cash.get(String(rider._id))?.balance || 0,
    counts: { open, deliveredToday },
  };
}

export async function riderTasks(req) {
  const rider = await loadMe(req);
  const scope = String(req.query.scope || "today");
  const today = dayKey();
  const { page, limit, skip } = paginate(req.query);
  let filter;
  let sort = { dueDate: 1, createdAt: 1 };
  if (scope === "open") filter = { riderId: rider._id, status: { $in: OPEN_STATUSES } };
  else if (scope === "done") {
    filter = { riderId: rider._id, status: { $in: TERMINAL_TASK_STATUSES } };
    sort = { completedAt: -1, updatedAt: -1 };
  } else if (scope === "today") {
    filter = {
      riderId: rider._id,
      $or: [{ status: { $in: OPEN_STATUSES } }, { status: { $in: TERMINAL_TASK_STATUSES }, completedAt: { $gte: startOfDay(today), $lte: endOfDay(today) } }],
    };
  } else throw new AppError(400, "scope must be today, open or done", "VALIDATION_ERROR");
  const [rows, total] = await Promise.all([
    DeliveryTask.find(filter).sort(sort).skip(skip).limit(limit),
    DeliveryTask.countDocuments(filter),
  ]);
  return { scope, ...paginated(await presentTasks(rows, { withOrders: true }), total, { page, limit }) };
}

export async function riderTask(req, id) {
  const { task } = await loadMyTask(req, id);
  const [out] = await presentTasks([task], { withOrders: true });
  return out;
}

export async function riderCashMine(req) {
  return cashHistory(await loadMe(req), req.query);
}

export async function acceptTask(req, id) {
  const { task } = await loadMyTask(req, id);
  await moveTask(task, ["assigned"], "accepted", { by: req.user._id, note: "Accepted by the rider" });
  return riderTask(req, id);
}

export async function rejectTask(req, id, { reason = "" } = {}) {
  const { rider, task } = await loadMyTask(req, id);
  const updated = await moveTask(task, ["assigned", "accepted"], "unassigned", {
    by: req.user._id,
    note: `Rejected by ${rider.name}${reason ? `: ${reason}` : ""}`,
    set: { riderId: null, runId: null, assignedAt: null },
  });
  await detachFromRun(task);
  emitDomain("RIDER_REJECTED_TASK", {
    tenantId: updated.tenantId,
    riderId: rider._id,
    riderName: rider.name,
    taskId: updated._id,
    orderId: updated.orderId,
    orderNumber: updated.orderNumber,
    reason: String(reason || "").slice(0, 300),
    resource: "delivery_task",
    resourceId: updated._id,
  });
  return { ok: true, id: updated._id, status: updated.status };
}

/** Picked the parcel up at the store: the order is shipped. */
export async function pickupTask(req, id) {
  const { rider, task } = await loadMyTask(req, id);
  if (task.kind !== "delivery") throw new AppError(400, "Use pickup-return for return pickups", "INVALID_STATE");
  const order = await orderFor(task);
  if (!["ready_to_ship", "shipped"].includes(order.status)) {
    throw new AppError(409, `Order is ${order.status}; it cannot be picked up`, "INVALID_STATE");
  }
  const updated = await moveTask(task, ["accepted"], "picked_up", { by: req.user._id, note: "Picked up from the store" });
  try {
    if (order.status === "ready_to_ship") {
      await advanceOrder(order, "shipped", { actorId: req.user._id, note: `Picked up by ${rider.name}`, riderAction: true });
    }
  } catch (err) {
    await DeliveryTask.updateOne({ _id: updated._id, status: "picked_up" }, { $set: { status: "accepted" }, $push: { history: hist("picked_up", "accepted", null, "Pickup rolled back") } });
    throw err;
  }
  await recomputeRun(updated.runId);
  return riderTask(req, id);
}

function otpHash(taskId, code) {
  return crypto.createHmac("sha256", `msp:delivery-otp:${env.jwtAccessSecret}`).update(`${taskId}:${code}`).digest("hex");
}

function newDeliveryCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

async function sendDeliveryOtp(task, order, rider, code) {
  const phone = task.buyer?.phone || order?.buyerSnapshot?.phone || "";
  if (!phone) return { sent: false, skipped: "no-phone" };
  return sendFleetSms({
    phone,
    kind: "DELIVERY_OTP",
    vars: { name: task.buyer?.name || "", order: task.orderNumber, otp: code, rider: rider.name, phone: rider.phone, message: `Delivery code ${code}` },
    message: `Your order ${task.orderNumber} is out for delivery with ${rider.name} (${rider.phone}). Share code ${code} with the rider to receive it.`,
  }).catch((err) => {
    logger.error("delivery OTP sms failed", { taskId: String(task._id), err: err.message });
    return { sent: false };
  });
}

/** Leaving for the buyer: order -> out_for_delivery, buyer gets the rider's name + phone and a 6-digit code. */
export async function startTask(req, id) {
  const { rider, task } = await loadMyTask(req, id);
  if (task.kind !== "delivery") throw new AppError(400, "Return pickups have no delivery step", "INVALID_STATE");
  const order = await orderFor(task);
  if (!["shipped", "out_for_delivery"].includes(order.status)) {
    throw new AppError(409, `Order is ${order.status}; pick it up first`, "INVALID_STATE");
  }
  const code = newDeliveryCode();
  const updated = await moveTask(task, ["picked_up", "failed"], "out_for_delivery", {
    by: req.user._id,
    note: "Out for delivery",
    set: {
      "otp.hash": otpHash(task._id, code),
      "otp.cipher": encryptSecret(code),
      "otp.sentAt": new Date(),
      "otp.attempts": 0,
      "otp.resends": 0,
      "otp.verifiedAt": null,
      rescheduledFor: null,
      dueDate: dayKey(),
    },
  });
  try {
    if (order.status === "shipped") {
      await advanceOrder(order, "out_for_delivery", {
        actorId: req.user._id,
        note: `Out for delivery with ${rider.name}`,
        riderAction: true,
        eventExtra: { rider: { name: rider.name, phone: rider.phone }, deliveryMethod: "own_fleet" },
      });
    }
  } catch (err) {
    await DeliveryTask.updateOne({ _id: updated._id, status: "out_for_delivery" }, { $set: { status: task.status }, $push: { history: hist("out_for_delivery", task.status, null, "Start rolled back") } });
    throw err;
  }
  await sendDeliveryOtp(updated, order, rider, code);
  await recomputeRun(updated.runId);
  return riderTask(req, id);
}

/** Re-send the buyer's code (30 s cooldown, 5 resends). After 5 wrong tries a NEW code is issued. */
export async function resendOtp(req, id) {
  const { rider, task } = await loadMyTask(req, id, { otp: true });
  if (task.status !== "out_for_delivery") throw new AppError(409, "The delivery is not out for delivery", "INVALID_STATE");
  const since = task.otp?.sentAt ? Date.now() - new Date(task.otp.sentAt).getTime() : Infinity;
  if (since < OTP_RESEND_COOLDOWN_MS) {
    const retryAfter = Math.ceil((OTP_RESEND_COOLDOWN_MS - since) / 1000);
    throw new AppError(429, `Wait ${retryAfter} seconds before sending the code again`, "OTP_COOLDOWN", { retryAfter });
  }
  if ((task.otp?.resends || 0) >= OTP_MAX_RESENDS) throw new AppError(429, "The code was sent too many times. Contact the store.", "OTP_RESEND_LIMIT");
  let code = decryptSecret(task.otp?.cipher);
  const set = { "otp.sentAt": new Date() };
  if (!code || (task.otp?.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    code = newDeliveryCode();
    Object.assign(set, { "otp.hash": otpHash(task._id, code), "otp.cipher": encryptSecret(code), "otp.attempts": 0 });
  }
  const updated = await DeliveryTask.findOneAndUpdate(
    { _id: task._id, status: "out_for_delivery" },
    { $set: set, $inc: { "otp.resends": 1 }, $push: { history: hist("out_for_delivery", "out_for_delivery", req.user._id, "Delivery code sent again") } },
    { new: true }
  );
  if (!updated) throw new AppError(409, "The delivery changed. Refresh and try again.", "INVALID_STATE");
  const order = await Order.findById(task.orderId).lean();
  await sendDeliveryOtp(updated, order, rider, code);
  return { ok: true, sentAt: updated.otp.sentAt, resends: updated.otp.resends, cooldownSeconds: OTP_RESEND_COOLDOWN_MS / 1000 };
}

/**
 * Hand over with the buyer's code (no skipping). COD: `cod.method` cash (cash goes on the rider's
 * cash in hand; the store holds it -> codCollection.by "seller", netted from payouts) or upi_qr
 * (paid to the platform's Razorpay QR first -> codCollection.by "platform").
 */
export async function deliverTask(req, id, { otp, photoFileId = null, cod = null } = {}) {
  const { rider, task } = await loadMyTask(req, id, { otp: true });
  if (task.kind !== "delivery") throw new AppError(400, "Use return-to-store for return pickups", "INVALID_STATE");
  if (task.status !== "out_for_delivery") throw new AppError(409, `This delivery is ${TASK_STATUS_LABELS[task.status]}`, "INVALID_STATE");
  if ((task.otp?.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    throw new AppError(429, "Too many wrong codes. Send a new code to the buyer.", "OTP_LOCKED");
  }
  const code = String(otp || "").trim();
  const expected = task.otp?.hash || "";
  const given = otpHash(task._id, code);
  const ok = /^\d{6}$/.test(code) && expected.length === given.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
  if (!ok) {
    const bumped = await DeliveryTask.findOneAndUpdate({ _id: task._id }, { $inc: { "otp.attempts": 1 } }, { new: true });
    const left = Math.max(0, OTP_MAX_ATTEMPTS - (bumped?.otp?.attempts || OTP_MAX_ATTEMPTS));
    throw new AppError(400, left ? `Wrong code. ${left} tries left.` : "Wrong code. Send a new code to the buyer.", "OTP_INVALID", { attemptsLeft: left });
  }
  const order = await orderFor(task);
  if (order.status !== "out_for_delivery") throw new AppError(409, `Order is ${order.status}`, "INVALID_STATE");
  const proof = photoFileId ? await assertPrivateFile(task.tenantId, photoFileId, { uploadedBy: req.user._id, folders: ["delivery"] }) : null;

  let method = null;
  if (order.paymentMethod === "cod") {
    method = task.cod?.paidAt ? "upi_qr" : cod?.method || null;
    if (!method) throw new AppError(400, "Choose how the buyer paid: cash or UPI QR", "VALIDATION_ERROR", { fields: { "cod.method": "Required for cash on delivery" } });
    if (method === "upi_qr" && !task.cod?.paidAt) {
      throw new AppError(409, "The UPI payment has not arrived yet. Wait for it or collect cash.", "COD_NOT_PAID");
    }
  }
  // Claim the hand-over (verifiedAt) so a double tap cannot deliver twice.
  const claimed = await DeliveryTask.findOneAndUpdate(
    { _id: task._id, status: "out_for_delivery", "otp.verifiedAt": null },
    { $set: { "otp.verifiedAt": new Date() } },
    { new: true }
  );
  if (!claimed) throw new AppError(409, "This delivery is already being completed", "INVALID_STATE");
  try {
    await advanceOrder(order, "delivered", {
      actorId: req.user._id,
      note: `Delivered by ${rider.name} (buyer code verified)`,
      riderAction: true,
      codCollectedBy: method === "cash" ? "seller" : method === "upi_qr" ? "platform" : null,
      codPaymentId: method === "upi_qr" ? task.cod?.razorpayPaymentId || "" : "",
      eventExtra: { rider: { name: rider.name, phone: rider.phone }, deliveryMethod: "own_fleet", codMethod: method },
    });
  } catch (err) {
    await DeliveryTask.updateOne({ _id: task._id }, { $set: { "otp.verifiedAt": null } });
    throw err;
  }
  const now = new Date();
  const updated = await moveTask(claimed, ["out_for_delivery"], "delivered", {
    by: req.user._id,
    note: method ? `Delivered (COD: ${method === "cash" ? "cash" : "UPI QR"})` : "Delivered",
    set: {
      completedAt: now,
      proofPhotoFileId: proof,
      "cod.method": method,
      "cod.collectedAt": method ? now : null,
    },
  });
  if (method === "cash") {
    await RiderCashEntry.updateOne(
      { taskId: task._id, kind: "collected" },
      {
        $setOnInsert: {
          tenantId: task.tenantId,
          riderId: rider._id,
          kind: "collected",
          amountPaise: toPaise(order.total),
          taskId: task._id,
          orderId: order._id,
          orderNumber: order.orderNumber,
          note: "COD cash collected",
          by: req.user._id,
          at: now,
        },
      },
      { upsert: true }
    );
  }
  await Rider.updateOne({ _id: rider._id }, { $inc: { "stats.delivered": 1 } });
  await recomputeRun(updated.runId);
  return riderTask(req, id);
}

/** UPI QR (platform Razorpay account) for the exact COD amount; single use, fixed amount. */
export async function codQr(req, id) {
  const { task } = await loadMyTask(req, id);
  if (task.status !== "out_for_delivery") throw new AppError(409, "Start the delivery first", "INVALID_STATE");
  const order = await orderFor(task);
  if (order.paymentMethod !== "cod") throw new AppError(400, "This order is already paid", "NOT_COD");
  const amountPaise = toPaise(order.total);
  if (task.cod?.paidAt) return qrState(task);
  if (task.cod?.razorpayQrId && task.cod.qrAmountPaise === amountPaise) return qrState(task);
  if (!razorpayConfigured()) throw new AppError(503, "UPI QR payments are not configured. Collect cash.", "PAYMENT_UNAVAILABLE");
  const store = await Tenant.findById(task.tenantId).select("name").lean();
  const qr = await createQrCode({
    type: "upi_qr",
    name: String(store?.name || "MSP").slice(0, 40),
    usage: "single_use",
    fixed_amount: true,
    payment_amount: amountPaise,
    description: `COD for order ${order.orderNumber}`.slice(0, 100),
    close_by: Math.floor(Date.now() / 1000) + QR_TTL_SECONDS,
    notes: { delivery_task_id: String(task._id), order_id: String(order._id), order_number: order.orderNumber, tenant_id: String(task.tenantId) },
  });
  const updated = await DeliveryTask.findOneAndUpdate(
    { _id: task._id, status: "out_for_delivery", "cod.paidAt": null },
    {
      $set: { "cod.razorpayQrId": qr.id, "cod.qrImageUrl": qr.image_url || "", "cod.qrAmountPaise": amountPaise },
      $push: { history: hist("out_for_delivery", "out_for_delivery", req.user._id, "UPI QR shown for COD") },
    },
    { new: true }
  );
  return qrState(updated || task);
}

function qrState(task) {
  return {
    qrId: task.cod?.razorpayQrId || null,
    imageUrl: task.cod?.qrImageUrl || "",
    amountPaise: task.cod?.qrAmountPaise || toPaise(task.cod?.amount || 0),
    paid: Boolean(task.cod?.paidAt),
    paidAt: task.cod?.paidAt || null,
    razorpayPaymentId: task.cod?.razorpayPaymentId || "",
  };
}

/** Poll: the QR's state; asks Razorpay for its payments when no webhook arrived yet. */
export async function codQrStatus(req, id) {
  const { task } = await loadMyTask(req, id);
  if (!task.cod?.razorpayQrId) throw new AppError(404, "No UPI QR for this delivery", "NOT_FOUND");
  if (!task.cod.paidAt && razorpayConfigured()) {
    try {
      const res = await fetchQrPayments(task.cod.razorpayQrId);
      const paid = (res?.items || []).find((p) => p.status === "captured");
      if (paid) await handleFleetQrEvent({ qrId: task.cod.razorpayQrId, payment: paid });
    } catch (err) {
      logger.warn("QR payment poll failed", { taskId: String(task._id), err: err.message });
    }
  }
  return qrState(await DeliveryTask.findById(task._id));
}

/**
 * Razorpay QR payment (webhook qr_code.credited / payment.captured on a delivery QR, or the poll):
 * marks the task's COD as paid by UPI. Returns false when the QR / payment is not a delivery one.
 */
export async function handleFleetQrEvent({ qrId = "", payment = null, notes = {} } = {}) {
  let task = null;
  if (qrId) task = await DeliveryTask.findOne({ "cod.razorpayQrId": String(qrId) });
  if (!task && notes?.delivery_task_id && mongoose.isValidObjectId(String(notes.delivery_task_id))) {
    task = await DeliveryTask.findById(String(notes.delivery_task_id));
  }
  if (!task) return false;
  if (payment?.status && !["captured", "authorized"].includes(payment.status)) return true;
  const amount = Number(payment?.amount ?? 0);
  if (task.cod?.qrAmountPaise && amount && amount !== task.cod.qrAmountPaise) {
    logger.error("delivery QR amount mismatch", { taskId: String(task._id), amount, expected: task.cod.qrAmountPaise });
    emitDomain("PAYMENT_MISMATCH", { razorpayOrderId: `qr:${qrId}`, razorpayPaymentId: payment?.id || "", amountPaise: amount, expected: task.cod.qrAmountPaise });
    return true;
  }
  await DeliveryTask.updateOne(
    { _id: task._id, "cod.paidAt": null },
    {
      $set: { "cod.paidAt": new Date(), "cod.razorpayPaymentId": String(payment?.id || ""), "cod.method": "upi_qr" },
      $push: { history: hist(task.status, task.status, null, "COD paid by UPI QR") },
    }
  );
  return true;
}

/**
 * Failed attempt (reason recorded, no re-delivery charge). Below the store's max attempts the
 * delivery is rescheduled for the next day (kept on the rider or back to the pool per
 * fleet.keepRiderOnReschedule) and the order goes back to shipped; at the max the order returns to
 * the store (rto_in_transit; rider then calls return-to-store).
 */
export async function failTask(req, id, { reason, note = "", photoFileId = null }) {
  const { rider, task } = await loadMyTask(req, id);
  if (!DELIVERY_FAIL_REASONS.includes(reason)) throw new AppError(400, "Unknown reason", "VALIDATION_ERROR");
  const settings = await fleetSettings(task.tenantId);
  const photo = photoFileId ? await assertPrivateFile(task.tenantId, photoFileId, { uploadedBy: req.user._id, folders: ["delivery"] }) : null;
  const attempt = { at: new Date(), reason, note: String(note || "").slice(0, 500), photoFileId: photo, riderId: rider._id };
  const count = (task.attempts || []).length + 1;
  const max = Math.max(1, task.maxAttempts || settings.maxAttempts);
  const label = FAIL_REASON_LABELS[reason] || reason;
  const tomorrow = addDays(dayKey(), 1);
  const keep = settings.keepRiderOnReschedule;
  const final = count >= max;

  if (task.kind === "return_pickup") {
    // "failed": a pickup kept on the rider after an earlier failed attempt can fail again.
    const updated = await moveTask(task, ["accepted", "assigned", "failed"], "failed", {
      by: req.user._id,
      note: `Pickup attempt ${count} failed: ${label}`,
      push: { attempts: attempt },
      set: final
        ? { riderId: null, runId: null, assignedAt: null }
        : { dueDate: tomorrow, rescheduledFor: startOfDay(tomorrow), ...(keep ? {} : { riderId: null, runId: null, assignedAt: null }) },
    });
    if (final || !keep) await detachFromRun(task);
    else await attachToRun(updated, rider._id, tomorrow);
    await Rider.updateOne({ _id: rider._id }, { $inc: { "stats.failed": 1 } });
    emitDomain("RIDER_PICKUP_FAILED", { tenantId: task.tenantId, taskId: task._id, orderId: task.orderId, orderNumber: task.orderNumber, reason, final, resource: "delivery_task", resourceId: task._id });
    if (final) {
      // Phase 6: the last attempt failed -> the return is closed as pickup_failed (buyer told, can dispute).
      try {
        await markReturnPickupFailed(task.orderId, {
          actorId: req.user._id,
          reason: `The rider could not pick up the return after ${count} attempt(s): ${label}`,
          source: "rider",
          returnId: task.returnId,
        });
      } catch (err) {
        if (err.code !== "INVALID_STATE") console.error("return pickup failed (rider)", String(task.orderId), err.message);
      }
    }
    return riderTask(req, id).catch(() => presentTask(updated));
  }

  const order = await orderFor(task);
  if (order.status !== "out_for_delivery") throw new AppError(409, `Order is ${order.status}`, "INVALID_STATE");
  let updated;
  if (final) {
    updated = await moveTask(task, ["out_for_delivery"], "returning", {
      by: req.user._id,
      note: `Attempt ${count} failed (${label}); returning to the store`,
      push: { attempts: attempt },
      set: { "otp.sentAt": null },
    });
    try {
      await markRtoInTransit(order, req.user._id, `Delivery attempt ${count} failed: ${label}. Returning to the store.`);
    } catch (err) {
      await DeliveryTask.updateOne({ _id: task._id, status: "returning" }, { $set: { status: "out_for_delivery" }, $pop: { attempts: 1 } });
      throw err;
    }
  } else {
    updated = await moveTask(task, ["out_for_delivery"], "failed", {
      by: req.user._id,
      note: `Attempt ${count} failed (${label}); rescheduled to ${tomorrow}`,
      push: { attempts: attempt },
      set: {
        dueDate: tomorrow,
        rescheduledFor: startOfDay(tomorrow),
        "otp.sentAt": null,
        ...(keep ? {} : { riderId: null, runId: null, assignedAt: null }),
      },
    });
    try {
      await transition(order, {
        from: "out_for_delivery",
        to: "shipped",
        actorId: req.user._id,
        note: `Delivery attempt ${count} failed: ${label}${note ? ` (${String(note).slice(0, 200)})` : ""}. Rescheduled to ${tomorrow}; no extra delivery charge.`,
      });
    } catch (err) {
      await DeliveryTask.updateOne({ _id: task._id, status: "failed" }, { $set: { status: "out_for_delivery", riderId: rider._id }, $pop: { attempts: 1 } });
      throw err;
    }
    if (keep) await attachToRun(updated, rider._id, tomorrow);
    else await detachFromRun(task);
  }
  await Rider.updateOne({ _id: rider._id }, { $inc: { "stats.failed": 1 } });
  emitDomain("DELIVERY_ATTEMPT_FAILED", {
    order: { _id: order._id, tenantId: order.tenantId, buyerId: order.buyerId, orderNumber: order.orderNumber, status: final ? "rto_in_transit" : "shipped", paymentMethod: order.paymentMethod, total: order.total, grandTotal: order.total },
    orderId: order._id,
    tenantId: order.tenantId,
    buyerId: order.buyerId,
    orderNumber: order.orderNumber,
    taskId: task._id,
    attempt: count,
    maxAttempts: max,
    reason,
    reasonLabel: label,
    final,
    rescheduledFor: final ? null : tomorrow,
    resource: "order",
    resourceId: order._id,
  });
  return riderTask(req, id).catch(() => presentTask(updated));
}

/** Return pickup: items checked + photos at the buyer's door; the return is on its way to the store. */
export async function pickupReturn(req, id, { itemCheck = [], photos = [] } = {}) {
  const { rider, task } = await loadMyTask(req, id);
  if (task.kind !== "return_pickup") throw new AppError(400, "Not a return pickup", "INVALID_STATE");
  const order = await orderFor(task);
  if (order.status !== "return_approved") throw new AppError(409, `Order is ${order.status}`, "INVALID_STATE");
  const lines = new Map((task.itemCheck || []).map((l) => [String(l.lineId), l]));
  const checked = [];
  for (const row of itemCheck || []) {
    const line = lines.get(String(row.lineId));
    if (!line) throw new AppError(400, "That item is not part of this return", "VALIDATION_ERROR", { fields: { itemCheck: "Unknown line" } });
    const okQty = Math.max(0, Number(row.okQty) || 0);
    const damagedQty = Math.max(0, Number(row.damagedQty) || 0);
    if (okQty + damagedQty > line.qty) throw new AppError(400, `More units than returned for ${line.name || "an item"}`, "VALIDATION_ERROR");
    checked.push({ lineId: line.lineId, name: line.name, qty: line.qty, okQty, damagedQty, note: String(row.note || "").slice(0, 300) });
  }
  for (const line of task.itemCheck || []) {
    if (!checked.some((c) => sameId(c.lineId, line.lineId))) checked.push({ lineId: line.lineId, name: line.name, qty: line.qty, okQty: 0, damagedQty: 0, note: "Not checked" });
  }
  const photoIds = [];
  for (const p of photos || []) photoIds.push(await assertPrivateFile(task.tenantId, p, { uploadedBy: req.user._id, folders: ["delivery"] }));
  // "failed": retrying a pickup that stayed with this rider after a failed attempt.
  const updated = await moveTask(task, ["accepted", "failed"], "picked_up", {
    by: req.user._id,
    note: `Return picked up by ${rider.name}`,
    set: { itemCheck: checked, photos: photoIds },
  });
  await Order.updateOne(
    { _id: order._id },
    {
      $push: {
        fulfillments: { kind: "return", carrier: "Own fleet", trackingNumber: "", status: "picked_up", shippedAt: new Date(), events: [{ status: "picked_up", note: `Picked up by ${rider.name}`, at: new Date() }] },
        statusHistory: { status: order.status, actorId: req.user._id, note: `Return picked up by the store's rider ${rider.name}`, at: new Date() },
      },
    }
  );
  await recomputeRun(updated.runId);
  emitDomain("RETURN_PICKED_UP", { tenantId: task.tenantId, orderId: order._id, orderNumber: order.orderNumber, taskId: task._id, buyerId: order.buyerId, resource: "order", resourceId: order._id });
  return riderTask(req, id);
}

/**
 * Back at the store. Delivery (after the last failed attempt): the order is returned to origin
 * (restock / refund / credit note, Phase 1 logic). Return pickup: handed to the store, which then
 * receives the return (POST /orders/:id/return/receive, damaged qty pre-filled from itemCheck).
 */
export async function returnToStore(req, id, { note = "" } = {}) {
  const { rider, task } = await loadMyTask(req, id);
  const order = await orderFor(task);
  if (task.kind === "return_pickup") {
    const updated = await moveTask(task, ["picked_up"], "returned_to_store", {
      by: req.user._id,
      note: note || "Return handed to the store",
      set: { completedAt: new Date() },
    });
    await Order.updateOne(
      { _id: order._id, fulfillments: { $elemMatch: { kind: "return", carrier: "Own fleet", status: "picked_up" } } },
      { $set: { "fulfillments.$.status": "delivered_to_store", "fulfillments.$.lastScanAt": new Date() } }
    );
    await recomputeRun(updated.runId);
    emitDomain("RETURN_AT_STORE", { tenantId: task.tenantId, orderId: order._id, orderNumber: order.orderNumber, taskId: task._id, resource: "order", resourceId: order._id });
    return riderTask(req, id);
  }
  if (task.status !== "returning") throw new AppError(409, `This delivery is ${TASK_STATUS_LABELS[task.status]}`, "INVALID_STATE");
  // returnToOrigin closes the task (hooks.closeTasksOnRto) inside the order transaction.
  await returnToOrigin(order, req.user._id, note || `Returned to the store by ${rider.name}`);
  await recomputeRun(task.runId);
  return riderTask(req, id);
}

/* ================================================================== order views */

/**
 * `delivery` block of GET /orders/:id.
 *  buyer: { method, status, statusLabel, rider {name, phone} | null, otp "123456" | null,
 *           attempts [{at, reason, reasonLabel}], attemptsCount, maxAttempts, rescheduledFor, returnPickup }
 *     rider + otp only while the order and the task are out for delivery.
 *  staff: { method, riderManaged, task (presentTask, no code), returnPickups [presentTask] }
 */
export async function orderDeliveryView(req, order, { buyer = false } = {}) {
  const pickupOnly = (order.items || []).length > 0 && (order.items || []).every((i) => i.fulfillmentMode === "store_pickup");
  const method = order.deliveryMethod || (pickupOnly ? "pickup" : "partner");
  if (method !== "own_fleet") {
    const extra = await DeliveryTask.exists({ orderId: order._id });
    if (!extra) return { method, riderManaged: false };
  }
  const tasks = await DeliveryTask.find({ orderId: order._id }).select("+otp.cipher").sort({ createdAt: 1 });
  const delivery = tasks.find((t) => t.kind === "delivery") || null;
  const pickups = tasks.filter((t) => t.kind === "return_pickup");
  const riderIds = tasks.map((t) => t.riderId).filter(Boolean);
  const riders = riderIds.length ? await Rider.find({ _id: { $in: riderIds } }).lean() : [];
  const riderOf = (t) => riders.find((r) => sameId(r._id, t?.riderId)) || null;
  if (buyer) {
    const live = delivery && delivery.status === "out_for_delivery" && order.status === "out_for_delivery";
    const r = live ? riderOf(delivery) : null;
    const lastPickup = pickups[pickups.length - 1] || null;
    let otp = live ? decryptSecret(delivery.otp?.cipher) : null;
    if (live && !otp) {
      // Unreadable stored code (e.g. the encryption key changed): issue a fresh one so the buyer
      // can still hand it over; the rider's next check uses the new hash.
      otp = newDeliveryCode();
      await DeliveryTask.updateOne(
        { _id: delivery._id, status: "out_for_delivery" },
        {
          $set: { "otp.hash": otpHash(delivery._id, otp), "otp.cipher": encryptSecret(otp), "otp.attempts": 0 },
          $push: { history: hist("out_for_delivery", "out_for_delivery", null, "Delivery code re-issued (stored code unreadable)") },
        }
      );
    }
    return {
      method,
      status: delivery?.status || null,
      statusLabel: delivery ? TASK_STATUS_LABELS[delivery.status] : null,
      rider: r ? { name: r.name, phone: r.phone } : null,
      otp,
      attempts: (delivery?.attempts || []).map((a) => ({ at: a.at, reason: a.reason, reasonLabel: FAIL_REASON_LABELS[a.reason] || a.reason })),
      attemptsCount: (delivery?.attempts || []).length,
      maxAttempts: delivery?.maxAttempts || null,
      rescheduledFor: delivery?.status === "failed" ? delivery.rescheduledFor : null,
      returnPickup: lastPickup ? { status: lastPickup.status, statusLabel: TASK_STATUS_LABELS[lastPickup.status], returnId: lastPickup.returnId } : null,
    };
  }
  return {
    method,
    riderManaged: method === "own_fleet",
    task: delivery ? presentTask(delivery, { rider: riderOf(delivery) }) : null,
    returnPickups: pickups.map((t) => presentTask(t, { rider: riderOf(t) })),
  };
}

/** Damaged qty per order line from the rider's item check of a return (for receiveReturn defaults). */
export async function returnItemCheckDamage(orderId, returnId) {
  const task = await DeliveryTask.findOne({ orderId, kind: "return_pickup", returnId, status: { $in: ["picked_up", "returned_to_store"] } }).lean();
  if (!task) return null;
  return (task.itemCheck || []).filter((l) => l.damagedQty > 0).map((l) => ({ itemId: l.lineId, damagedQty: l.damagedQty }));
}
