import mongoose from "mongoose";
import { Warehouse } from "./warehouse.model.js";
import { Inventory } from "./inventory.model.js";
import { InventoryTransaction, STOCK_TX_REASONS } from "./transaction.model.js";
import { StockReservation, ACTIVE_RESERVATION_STATUSES, RESERVATION_STATUSES } from "./reservation.model.js";
import { Order } from "../orders/order.model.js";
import { parseBound } from "../reports/time.js";
import { Cart } from "../cart/cart.model.js";
import { Product } from "../catalog/product.model.js";
import { ProductVariant } from "../catalog/variant.model.js";
import { AppError } from "../../utils/AppError.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import { emitDomain } from "../../utils/events.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { withTransaction, withSession, afterCommit } from "../../utils/transaction.js";

/* ------------------------------------------------------------------ helpers */

function oid(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === "object" && value._id) return oid(value._id);
  return mongoose.Types.ObjectId.isValid(String(value)) ? new mongoose.Types.ObjectId(String(value)) : null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const COUNTERS = ["available", "reserved", "committed", "damaged", "incoming"];

function lowExpr(availableRef = "$available") {
  return {
    $or: [
      { $lte: [availableRef, 0] },
      {
        $and: [
          { $gt: [{ $ifNull: ["$lowStockThreshold", 0] }, 0] },
          { $lte: [availableRef, { $ifNull: ["$lowStockThreshold", 0] }] },
        ],
      },
    ],
  };
}

/**
 * Atomic counter change on one Inventory row, with `isLow` recomputed in the same update.
 * `filter` must carry the guards (e.g. `available: { $gte: qty }`). Returns the new row or null.
 */
async function incStock(filter, inc, session, set = {}) {
  const first = {};
  for (const [key, value] of Object.entries(inc)) {
    if (!COUNTERS.includes(key)) throw new Error(`Unknown counter ${key}`);
    if (!value) continue;
    first[key] = { $add: [{ $ifNull: [`$${key}`, 0] }, value] };
  }
  Object.assign(first, set);
  const pipeline = [
    ...(Object.keys(first).length ? [{ $set: first }] : []),
    {
      $set: {
        isLow: lowExpr(),
        // A new low-stock episode starts once the row recovers, so the job alerts exactly once per episode.
        lastLowStockAlertAt: { $cond: [lowExpr(), "$lastLowStockAlertAt", null] },
      },
    },
  ];
  return Inventory.findOneAndUpdate(filter, pipeline, withSession(session, { new: true }));
}

async function ensureRow({ tenantId, warehouseId, variantId, sku, session }) {
  await Inventory.updateOne(
    { tenantId, warehouseId, variantId },
    { $setOnInsert: { sku: sku || "", available: 0, reserved: 0, committed: 0, damaged: 0, incoming: 0 } },
    withSession(session, { upsert: true })
  );
}

async function writeStockTx({ stock, reason, qty, actorId = null, reference = "", note = "", reservationId = null, session }) {
  await InventoryTransaction.create(
    [
      {
        tenantId: stock.tenantId,
        warehouseId: stock.warehouseId,
        variantId: stock.variantId,
        sku: stock.sku || "-",
        reason,
        qty,
        availableAfter: stock.available,
        reservedAfter: stock.reserved,
        committedAfter: stock.committed,
        damagedAfter: stock.damaged || 0,
        actorId,
        reservationId,
        reference: reference || "",
        note: note || "",
      },
    ],
    withSession(session)
  );
}

async function assertWarehouse(tenantId, warehouseId, session) {
  const wh = await Warehouse.findOne({ _id: warehouseId, tenantId }, null, withSession(session)).lean();
  if (!wh) throw new AppError(404, "Warehouse not found for this store", "NOT_FOUND");
  return wh;
}

/** Emit LOW_STOCK / OUT_OF_STOCK once per low episode (atomic claim, safe across instances). */
export async function alertIfLow(row) {
  if (!row?.isLow || row.lastLowStockAlertAt) return false;
  const claimed = await Inventory.findOneAndUpdate(
    { _id: row._id, isLow: true, lastLowStockAlertAt: null },
    { $set: { lastLowStockAlertAt: new Date() } },
    { new: true }
  );
  if (!claimed) return false;
  emitDomain(claimed.available <= 0 ? "OUT_OF_STOCK" : "LOW_STOCK", {
    tenantId: claimed.tenantId,
    variantId: claimed.variantId,
    sku: claimed.sku,
    available: claimed.available,
    warehouseId: claimed.warehouseId,
  });
  return true;
}

/** Tell restock subscribers (catalog) once stock is back; runs after commit, never throws. */
export function notifyRestockLater(session, { tenantId, variantId }) {
  afterCommit(session, async () => {
    const mod = await import("../catalog/restock.js");
    if (typeof mod.notifyRestock === "function") await mod.notifyRestock({ tenantId, variantId });
    else if (typeof mod.notifyRestockForVariant === "function") await mod.notifyRestockForVariant(variantId);
  });
}

/** Keep the denormalised Inventory.sku in step when a variant SKU is renamed (catalog calls this). */
export async function syncInventorySku({ tenantId, variantId, sku, session = null }) {
  if (!sku) return 0;
  const res = await Inventory.updateMany({ tenantId, variantId }, { $set: { sku: String(sku) } }, withSession(session));
  return res.modifiedCount || 0;
}

/** Deleted (archived) variants cannot be given sellable stock. */
function assertVariantLive(variant) {
  if (variant?.deletedAt || variant?.status === "archived") {
    throw new AppError(409, "This variant has been deleted; restore it before adding stock", "VARIANT_DELETED");
  }
}

/* -------------------------------------------------------------- warehouses */

const WAREHOUSE_FIELDS = ["name", "code", "addressLine1", "city", "state", "postalCode", "country", "latitude", "longitude", "status"];

function pickWarehouse(body = {}) {
  const out = {};
  for (const key of WAREHOUSE_FIELDS) if (body[key] !== undefined) out[key] = body[key];
  if (out.code) out.code = String(out.code).toUpperCase();
  return out;
}

export async function listWarehouses(req) {
  const filter = tenantFilter(req);
  if (req.query?.page || req.query?.limit) {
    const { page, limit, skip } = paginate(req.query);
    const [data, total] = await Promise.all([
      Warehouse.find(filter).sort({ name: 1 }).skip(skip).limit(limit),
      Warehouse.countDocuments(filter),
    ]);
    return paginated(data, total, { page, limit });
  }
  return Warehouse.find(filter).sort({ name: 1 }).limit(500);
}

function isDuplicateKey(err) {
  return err?.code === 11000 || /E11000/.test(String(err?.message || ""));
}

/** E11000 on the { tenantId, code } index -> 409 with a readable message. */
function warehouseConflict(err) {
  if (isDuplicateKey(err)) return new AppError(409, "Warehouse code already exists", "DUPLICATE_WAREHOUSE_CODE");
  return err;
}

export async function createWarehouse(req, body) {
  try {
    return await Warehouse.create({ ...pickWarehouse(body), tenantId: req.tenantId });
  } catch (err) {
    throw warehouseConflict(err);
  }
}

export async function updateWarehouse(req, id, body) {
  let doc;
  try {
    doc = await Warehouse.findOneAndUpdate({ _id: id, ...tenantFilter(req) }, { $set: pickWarehouse(body) }, {
      new: true,
      runValidators: true,
    });
  } catch (err) {
    throw warehouseConflict(err);
  }
  if (!doc) throw new AppError(404, "Warehouse not found", "NOT_FOUND");
  return doc;
}

/* --------------------------------------------------------------- listing */

function idParam(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const id = oid(value);
  if (!id) throw new AppError(400, `Invalid ${name}`, "INVALID_ID");
  return id;
}

function enumParam(value, allowed, name) {
  if (value === undefined || value === null || value === "") return [];
  const out = String(value).split(",").map((v) => v.trim()).filter(Boolean);
  const bad = out.find((v) => !allowed.includes(v));
  if (bad) throw new AppError(400, `Invalid ${name} "${bad}". Use one of: ${allowed.join(", ")}`, "VALIDATION_ERROR");
  return out;
}

function createdRange(query) {
  const from = parseBound(query.from);
  const to = parseBound(query.to, true);
  if (!from && !to) return null;
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return range;
}

/**
 * Inventory list / export filter. Archived rows (deleted variants) are always excluded.
 * Query: warehouseId, variantId, lowStock=true, q (SKU or product name).
 */
export async function buildInventoryFilter(req, query = req.query || {}) {
  const filter = { ...tenantFilter(req), archived: { $ne: true } };
  const warehouseId = idParam(query.warehouseId, "warehouseId");
  const variantId = idParam(query.variantId, "variantId");
  if (warehouseId) filter.warehouseId = warehouseId;
  if (variantId) filter.variantId = variantId;
  const productId = idParam(query.productId, "productId");
  if (productId) {
    // Only rows whose variant belongs to this product (tenant-scoped like the rest of the filter).
    const ids = (await ProductVariant.find({ ...tenantFilter(req), productId }).select("_id").lean()).map((v) => v._id);
    filter.variantId = variantId ? (ids.some((id) => String(id) === String(variantId)) ? variantId : { $in: [] }) : { $in: ids };
  }
  if (String(query.lowStock) === "true") filter.isLow = true;
  if (query.q) {
    const rx = new RegExp(escapeRegex(String(query.q).slice(0, 100)), "i");
    const products = await Product.find({ ...tenantFilter(req), name: rx }).select("_id").limit(50);
    const variants = await ProductVariant.find({
      ...tenantFilter(req),
      $or: [{ sku: rx }, { productId: { $in: products.map((p) => p._id) } }],
    })
      .select("_id")
      .limit(100);
    filter.$or = [{ sku: rx }, { variantId: { $in: variants.map((v) => v._id) } }];
  }
  return filter;
}

const INVENTORY_POPULATE = [
  { path: "warehouseId", select: "name code city" },
  {
    path: "variantId",
    select: "sku attributes sellingPrice listPrice productId status",
    populate: { path: "productId", select: "name images sku status" },
  },
];

export async function listInventory(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = await buildInventoryFilter(req);
  const [data, total] = await Promise.all([
    Inventory.find(filter).populate(INVENTORY_POPULATE).skip(skip).limit(limit).sort({ sku: 1 }),
    Inventory.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}

/** Export rows (lean, populated) for the same filter; `cap` rows max. */
export async function exportInventory(req, { cap = 1000 } = {}) {
  const filter = await buildInventoryFilter(req);
  const [rows, total] = await Promise.all([
    Inventory.find(filter).populate(INVENTORY_POPULATE).sort({ sku: 1 }).limit(cap).lean(),
    Inventory.countDocuments(filter),
  ]);
  return { rows, total, truncated: total > cap };
}

/** variant sku/name, product name, warehouse name/code and order number for list rows. */
async function describeRows(rows, { orderIdOf }) {
  const variantIds = [...new Set(rows.map((r) => String(r.variantId)).filter(Boolean))];
  const warehouseIds = [...new Set(rows.map((r) => String(r.warehouseId)).filter(Boolean))];
  const orderIds = [...new Set(rows.map(orderIdOf).filter(Boolean).map(String))];
  const [variants, warehouses, orders] = await Promise.all([
    ProductVariant.find({ _id: { $in: variantIds } }).select("sku attributes productId").populate("productId", "name").lean(),
    Warehouse.find({ _id: { $in: warehouseIds } }).select("name code").lean(),
    orderIds.length ? Order.find({ _id: { $in: orderIds } }).select("orderNumber status").lean() : [],
  ]);
  const vMap = new Map(variants.map((v) => [String(v._id), v]));
  const wMap = new Map(warehouses.map((w) => [String(w._id), w]));
  const oMap = new Map(orders.map((o) => [String(o._id), o]));
  return rows.map((row) => {
    const v = vMap.get(String(row.variantId));
    const w = wMap.get(String(row.warehouseId));
    const orderId = orderIdOf(row);
    const o = orderId ? oMap.get(String(orderId)) : null;
    return {
      ...row,
      variant: v ? { _id: v._id, sku: v.sku, attributes: v.attributes || {} } : null,
      product: v?.productId ? { _id: v.productId._id, name: v.productId.name } : null,
      productName: v?.productId?.name || "",
      warehouse: w ? { _id: w._id, name: w.name, code: w.code } : null,
      order: o ? { _id: o._id, orderNumber: o.orderNumber, status: o.status } : null,
      orderNumber: o?.orderNumber || "",
    };
  });
}

/**
 * Stock movements, newest first. Query: variantId, warehouseId, orderId, reason (comma list),
 * from/to (IST days or ISO), page/limit. Rows carry variant, product, warehouse and order.
 */
export async function listTransactions(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = tenantFilter(req);
  const variantId = idParam(req.query.variantId, "variantId");
  const warehouseId = idParam(req.query.warehouseId, "warehouseId");
  const orderId = idParam(req.query.orderId, "orderId");
  if (variantId) filter.variantId = variantId;
  if (warehouseId) filter.warehouseId = warehouseId;
  const reasons = enumParam(req.query.reason, STOCK_TX_REASONS, "reason");
  if (reasons.length) filter.reason = { $in: reasons };
  const range = createdRange(req.query);
  if (range) filter.createdAt = range;
  if (orderId) {
    const [holds, order] = await Promise.all([
      StockReservation.find({ "owner.type": "order", "owner.id": orderId }).select("_id").lean(),
      Order.findOne({ _id: orderId, ...tenantFilter(req) }).select("orderNumber").lean(),
    ]);
    const or = [{ reservationId: { $in: holds.map((h) => h._id) } }];
    if (order?.orderNumber) or.push({ reference: order.orderNumber });
    filter.$or = or;
  }
  const [rows, total] = await Promise.all([
    InventoryTransaction.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    InventoryTransaction.countDocuments(filter),
  ]);
  const resIds = rows.map((r) => r.reservationId).filter(Boolean);
  const holds = resIds.length ? await StockReservation.find({ _id: { $in: resIds } }).select("owner").lean() : [];
  const holdOrder = new Map(holds.filter((h) => h.owner?.type === "order").map((h) => [String(h._id), h.owner.id]));
  const data = await describeRows(rows, { orderIdOf: (r) => (r.reservationId ? holdOrder.get(String(r.reservationId)) : null) });
  return paginated(data, total, { page, limit });
}

/**
 * Stock holds, newest first. Query: variantId, warehouseId, orderId, status (comma list),
 * ownerType (cart|order), from/to, page/limit. Rows carry variant, product, warehouse and order.
 */
export async function listReservations(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = tenantFilter(req);
  const variantId = idParam(req.query.variantId, "variantId");
  const warehouseId = idParam(req.query.warehouseId, "warehouseId");
  const orderId = idParam(req.query.orderId, "orderId");
  if (variantId) filter.variantId = variantId;
  if (warehouseId) filter.warehouseId = warehouseId;
  if (orderId) {
    filter["owner.type"] = "order";
    filter["owner.id"] = orderId;
  } else if (req.query.ownerType) {
    filter["owner.type"] = enumParam(req.query.ownerType, ["cart", "order"], "ownerType")[0];
  }
  const statuses = enumParam(req.query.status, RESERVATION_STATUSES, "status");
  if (statuses.length) filter.status = { $in: statuses };
  const range = createdRange(req.query);
  if (range) filter.createdAt = range;
  const [rows, total] = await Promise.all([
    StockReservation.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    StockReservation.countDocuments(filter),
  ]);
  const data = await describeRows(rows, { orderIdOf: (r) => (r.owner?.type === "order" ? r.owner.id : null) });
  return paginated(data, total, { page, limit });
}

/* ------------------------------------------------------- manual adjustments */

export async function adjustStock(req, { warehouseId, variantId, reason, qty, note }) {
  const tenantId = req.tenantId;
  const n = Number(qty);
  if (!Number.isInteger(n) || n === 0) throw new AppError(400, "Quantity must be a non-zero whole number", "VALIDATION_ERROR");
  const variant = await ProductVariant.findOne({ _id: variantId, tenantId });
  if (!variant) throw new AppError(404, "Variant not found", "NOT_FOUND");
  await assertWarehouse(tenantId, warehouseId);
  const addsSellable = n > 0 && ["inward", "adjustment", "return"].includes(reason);
  // Adding sellable stock to an archived row un-archives it (the variant is live again);
  // a deleted variant cannot receive sellable stock.
  if (addsSellable) assertVariantLive(variant);

  let inc;
  let guard = {};
  if (["inward", "adjustment", "return"].includes(reason)) {
    inc = { available: n };
    if (n < 0) guard = { available: { $gte: -n } };
  } else if (reason === "incoming") {
    inc = { incoming: n };
    if (n < 0) guard = { incoming: { $gte: -n } };
  } else if (reason === "damage") {
    if (n <= 0) throw new AppError(400, "Damage quantity must be a positive number", "VALIDATION_ERROR");
    inc = { available: -n, damaged: n };
    guard = { available: { $gte: n } };
  } else {
    throw new AppError(400, "Unsupported adjust reason", "VALIDATION_ERROR");
  }

  const stock = await withTransaction(async (session) => {
    await ensureRow({ tenantId, warehouseId, variantId, sku: variant.sku, session });
    const row = await incStock({ tenantId, warehouseId, variantId, ...guard }, inc, session, addsSellable ? { archived: false } : {});
    if (!row) {
      throw new AppError(
        400,
        reason === "incoming" ? "Incoming cannot be negative" : "Insufficient available stock",
        "INSUFFICIENT_STOCK"
      );
    }
    await writeStockTx({ stock: row, reason, qty: n, actorId: req.user?._id, note, session });
    return row;
  });

  await alertIfLow(stock).catch(() => {});
  if (n > 0 && stock.available > 0 && ["inward", "return", "adjustment"].includes(reason)) {
    notifyRestockLater(null, { tenantId, variantId });
  }
  return stock;
}

/**
 * POST /inventory/set-quantity: set the sellable qty of one variant in one warehouse (absolute,
 * compare-and-set, never touches reserved/committed). Returns the updated row.
 */
export async function setQuantity(req, { variantId, warehouseId, qty, reason = "set", note = "" }) {
  return setAvailableQty({
    tenantId: req.tenantId,
    variantId,
    warehouseId,
    qty,
    userId: req.user?._id || null,
    reason,
    note: String(note || "").slice(0, 500),
  });
}

export async function updateThresholds(req, id, body = {}) {
  const set = {};
  if (body.lowStockThreshold != null) set.lowStockThreshold = Number(body.lowStockThreshold);
  if (body.incoming != null) set.incoming = Number(body.incoming);
  const stock = await incStock({ _id: id, ...tenantFilter(req) }, {}, null, set);
  if (!stock) throw new AppError(404, "Inventory row not found", "NOT_FOUND");
  emitDomain("INVENTORY_PUBLISHED", {
    tenantId: req.tenantId,
    variantId: stock.variantId,
    sku: stock.sku,
    lowStockThreshold: stock.lowStockThreshold,
  });
  await alertIfLow(stock).catch(() => {});
  return stock;
}

export async function transferStock(req, { fromWarehouseId, toWarehouseId, variantId, qty, note }) {
  const tenantId = req.tenantId;
  const n = Number(qty);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, "Quantity must be a positive whole number", "VALIDATION_ERROR");
  if (String(fromWarehouseId) === String(toWarehouseId)) {
    throw new AppError(400, "Warehouses must differ", "VALIDATION_ERROR");
  }
  const variant = await ProductVariant.findOne({ _id: variantId, tenantId });
  if (!variant) throw new AppError(404, "Variant not found", "NOT_FOUND");
  await Promise.all([assertWarehouse(tenantId, fromWarehouseId), assertWarehouse(tenantId, toWarehouseId)]);

  const result = await withTransaction(async (session) => {
    const source = await incStock(
      { tenantId, warehouseId: fromWarehouseId, variantId, available: { $gte: n } },
      { available: -n },
      session
    );
    if (!source) throw new AppError(400, "Insufficient stock to transfer", "INSUFFICIENT_STOCK");
    await writeStockTx({ stock: source, reason: "transfer_out", qty: -n, actorId: req.user?._id, note, session });
    await ensureRow({ tenantId, warehouseId: toWarehouseId, variantId, sku: source.sku || variant.sku, session });
    const dest = await incStock(
      { tenantId, warehouseId: toWarehouseId, variantId },
      { available: n },
      session,
      { archived: false }
    );
    await writeStockTx({ stock: dest, reason: "transfer_in", qty: n, actorId: req.user?._id, note, session });
    return { from: source, to: dest };
  });
  await alertIfLow(result.from).catch(() => {});
  notifyRestockLater(null, { tenantId, variantId });
  return result;
}

/* ------------------------------------------------- contract for catalog (C) */

async function defaultWarehouseFor(tenantId, variantId, session) {
  const rows = await Inventory.find({ tenantId, variantId }, null, withSession(session)).sort({ available: -1, createdAt: 1 });
  const live = rows.filter((row) => !row.archived);
  if (live.length) return live[0].warehouseId;
  if (rows.length) return rows[0].warehouseId;
  const wh = await Warehouse.findOne({ tenantId, status: "active" }, null, withSession(session)).sort({ createdAt: 1 });
  if (wh) return wh._id;
  const created = await Warehouse.findOneAndUpdate(
    { tenantId, code: "MAIN" },
    { $setOnInsert: { tenantId, code: "MAIN", name: "Main warehouse", status: "active" } },
    withSession(session, { upsert: true, new: true })
  );
  return created._id;
}

/**
 * Atomically set the sellable qty of a variant in one warehouse (default: the variant's main
 * row). Computes the delta against the current value with a compare-and-set, never touches
 * reserved/committed units, and writes an InventoryTransaction.
 */
export async function setAvailableQty({
  tenantId,
  variantId,
  warehouseId = null,
  qty,
  userId = null,
  reason = "adjustment",
  note = "",
  session = null,
}) {
  const target = Number(qty);
  if (!Number.isInteger(target) || target < 0) {
    throw new AppError(400, "Available quantity must be a whole number of at least 0", "VALIDATION_ERROR");
  }
  const run = async (s) => {
    const variant = await ProductVariant.findOne({ _id: variantId, tenantId }, null, withSession(s));
    if (!variant) throw new AppError(404, "Variant not found", "NOT_FOUND");
    if (target > 0) assertVariantLive(variant);
    const whId = warehouseId ? (await assertWarehouse(tenantId, warehouseId, s))._id : await defaultWarehouseFor(tenantId, variant._id, s);
    await ensureRow({ tenantId, warehouseId: whId, variantId: variant._id, sku: variant.sku, session: s });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row = await Inventory.findOne({ tenantId, warehouseId: whId, variantId: variant._id }, null, withSession(s));
      const delta = target - (row.available || 0);
      if (delta === 0 && (!row.archived || target === 0)) return row;
      const updated = await incStock(
        { _id: row._id, available: row.available || 0 },
        { available: delta },
        s,
        { archived: target > 0 ? false : Boolean(row.archived) }
      );
      if (!updated) continue;
      if (delta !== 0) {
        const txReason = ["adjustment", "inward", "return", "set"].includes(reason) ? reason : "adjustment";
        await writeStockTx({ stock: updated, reason: txReason, qty: delta, actorId: userId, note: note || `Set available to ${target}`, session: s });
        if (delta > 0) notifyRestockLater(s, { tenantId, variantId: variant._id });
      }
      return updated;
    }
    throw new AppError(409, "Stock changed while saving. Try again.", "STOCK_CONFLICT");
  };
  const row = session ? await run(session) : await withTransaction(run);
  if (!session) await alertIfLow(row).catch(() => {});
  return row;
}

/**
 * Variant was (soft-)deleted: drop cart holds on it, zero sellable stock and archive its rows.
 * Order holds (already sold units) are left alone so those orders can still be fulfilled.
 */
export async function deleteVariantInventory({ tenantId, variantId, session = null }) {
  const run = async (s) => {
    const holds = await StockReservation.find(
      { tenantId, variantId, status: "held", "owner.type": "cart" },
      null,
      withSession(s)
    );
    let releasedHolds = 0;
    for (const hold of holds) {
      const moved = await moveReservation({ reservationId: hold._id, from: "held", to: "released", note: "variant deleted", session: s });
      if (moved) {
        releasedHolds += 1;
        await clearCartPointer(hold, s);
      }
    }
    const rows = await Inventory.find({ tenantId, variantId }, null, withSession(s));
    for (const row of rows) {
      const zeroed = await incStock({ _id: row._id }, { available: -(row.available || 0) }, s, { archived: true });
      if (row.available) {
        await writeStockTx({ stock: zeroed, reason: "archive", qty: -row.available, note: "Variant deleted", session: s });
      }
    }
    return { rows: rows.length, releasedHolds };
  };
  return session ? run(session) : withTransaction(run);
}

/* ------------------------------------------------------------ reservations */

const MOVES = {
  "held>released": { inc: (q) => ({ reserved: -q, available: q }), guard: (q) => ({ reserved: { $gte: q } }), reason: "release" },
  "held>committed": { inc: (q) => ({ reserved: -q, committed: q }), guard: (q) => ({ reserved: { $gte: q } }), reason: "commit" },
  "committed>consumed": { inc: (q) => ({ committed: -q }), guard: (q) => ({ committed: { $gte: q } }), reason: "consume" },
  "committed>restored": { inc: (q) => ({ committed: -q, available: q }), guard: (q) => ({ committed: { $gte: q } }), reason: "restore" },
  "consumed>restored": {
    inc: (q, damaged) => ({ available: q - damaged, damaged }),
    guard: () => ({}),
    reason: "return",
  },
};

/**
 * Create a hold: moves `qty` from available to reserved and records who owns it.
 * Throws 409 INSUFFICIENT_STOCK when the warehouse cannot cover it.
 */
export async function reserve({ tenantId, warehouseId, variantId, qty, owner, expiresAt = null, reference = "", actorId = null, session }) {
  const n = Number(qty);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, "Reservation qty must be a positive whole number", "VALIDATION_ERROR");
  const stock = await incStock(
    { tenantId, warehouseId, variantId, archived: { $ne: true }, available: { $gte: n } },
    { available: -n, reserved: n },
    session
  );
  if (!stock) throw new AppError(409, "Insufficient stock", "INSUFFICIENT_STOCK");
  const [reservation] = await StockReservation.create(
    [
      {
        tenantId,
        warehouseId,
        variantId,
        qty: n,
        owner: { type: owner.type, id: owner.id, line: owner.line || null, cartId: owner.cartId || null },
        status: "held",
        active: true,
        expiresAt,
        reference,
        history: [{ from: null, to: "held", note: reference }],
      },
    ],
    withSession(session)
  );
  await writeStockTx({ stock, reason: "reserve", qty: -n, actorId, reference, reservationId: reservation._id, session });
  return reservation;
}

/**
 * Flip one reservation's status and move exactly its qty between counters, conditionally on
 * the reservation still being in `from`. Returns null (no-op) when it already moved.
 */
export async function moveReservation({ reservationId, from, to, note = "", damagedQty = 0, actorId = null, session, extraFilter = {} }) {
  const fromFilter = Array.isArray(from) ? { $in: from } : from;
  const set = { status: to, active: ACTIVE_RESERVATION_STATUSES.includes(to) };
  if (to !== "held") set.expiresAt = null;
  if (damagedQty) set.damagedQty = damagedQty;
  const previous = await StockReservation.findOneAndUpdate(
    { _id: reservationId, status: fromFilter, ...extraFilter },
    { $set: set, $push: { history: { from: Array.isArray(from) ? "*" : from, to, note, at: new Date() } } },
    withSession(session, { new: false })
  );
  if (!previous) return null;
  const rule = MOVES[`${previous.status}>${to}`];
  if (!rule) throw new AppError(500, `Unsupported stock move ${previous.status} -> ${to}`, "INVENTORY_STATE");
  const q = previous.qty;
  const damaged = Math.max(0, Math.min(q, Number(damagedQty) || 0));
  const stock = await incStock(
    { tenantId: previous.tenantId, warehouseId: previous.warehouseId, variantId: previous.variantId, ...rule.guard(q) },
    rule.inc(q, damaged),
    session
  );
  if (!stock) {
    // Counters disagree with the reservation documents; abort so the status flip rolls back.
    throw new AppError(409, "Inventory counters are out of sync for this item. Run the reservation migration.", "INVENTORY_DRIFT");
  }
  if ((rule.inc(q, damaged).available || 0) > 0) {
    notifyRestockLater(session, { tenantId: previous.tenantId, variantId: previous.variantId });
  }
  await writeStockTx({
    stock,
    reason: rule.reason,
    qty: rule.reason === "consume" ? -q : q,
    actorId,
    reference: previous.reference,
    note,
    reservationId: previous._id,
    session,
  });
  return { ...previous.toObject(), status: to, stock };
}

/** Atomically hand a held cart reservation to an order line. Null when it is no longer claimable. */
export async function reownReservation({ reservationId, fromOwner, toOwner, expect = {}, reference = "", session }) {
  const filter = {
    _id: reservationId,
    status: "held",
    "owner.type": fromOwner.type,
    "owner.id": fromOwner.id,
  };
  if (expect.qty != null) filter.qty = expect.qty;
  if (expect.warehouseId) filter.warehouseId = expect.warehouseId;
  if (expect.variantId) filter.variantId = expect.variantId;
  return StockReservation.findOneAndUpdate(
    filter,
    {
      $set: {
        owner: { type: toOwner.type, id: toOwner.id, line: toOwner.line || null, cartId: null },
        expiresAt: toOwner.expiresAt || null,
        reference: reference || "",
      },
      $push: { history: { from: "held", to: "held", note: `re-owned to ${toOwner.type}:${toOwner.id}`, at: new Date() } },
    },
    withSession(session, { new: true })
  );
}

export async function reservationsForOwner(type, id, session, statuses = null) {
  const filter = { "owner.type": type, "owner.id": id };
  if (statuses) filter.status = { $in: statuses };
  return StockReservation.find(filter, null, withSession(session));
}

/** Release (held) or restore (committed) every active hold of an order. */
export async function releaseOrderStock(orderId, { session, note = "", actorId = null } = {}) {
  const rows = await reservationsForOwner("order", orderId, session, ["held", "committed"]);
  for (const row of rows) {
    await moveReservation({
      reservationId: row._id,
      from: row.status,
      to: row.status === "held" ? "released" : "restored",
      note,
      actorId,
      session,
    });
  }
  return rows.length;
}

/** Order confirmed: held -> committed for every line. Fails if a line has no live hold. */
export async function commitOrderStock(order, { session, actorId = null } = {}) {
  const rows = await reservationsForOwner("order", order._id, session, ["held"]);
  const heldQty = rows.reduce((sum, row) => sum + row.qty, 0);
  const needQty = (order.items || []).reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
  if (heldQty < needQty) {
    throw new AppError(409, "Stock for this order is no longer reserved", "RESERVATION_MISSING");
  }
  for (const row of rows) {
    await moveReservation({ reservationId: row._id, from: "held", to: "committed", note: order.orderNumber, actorId, session });
  }
  return rows.length;
}

/** Goods left the warehouse: committed -> consumed. */
export async function consumeOrderStock(orderId, { session, actorId = null, note = "shipped" } = {}) {
  const rows = await reservationsForOwner("order", orderId, session, ["committed"]);
  for (const row of rows) {
    await moveReservation({ reservationId: row._id, from: "committed", to: "consumed", note, actorId, session });
  }
  return rows.length;
}

/**
 * Return received: consumed -> restored. `damagedByLine` maps order item id -> damaged units;
 * damaged units go to `damaged` instead of `available`.
 */
export async function restoreReturnedStock(orderId, { session, actorId = null, damagedByLine = {}, note = "return received" } = {}) {
  const rows = await reservationsForOwner("order", orderId, session, ["consumed"]);
  for (const row of rows) {
    const damagedQty = Number(damagedByLine[String(row.owner?.line || "")] || 0);
    await moveReservation({ reservationId: row._id, from: "consumed", to: "restored", damagedQty, note, actorId, session });
  }
  return rows.length;
}

async function clearCartPointer(hold, session) {
  if (!hold.owner?.cartId) return;
  await Cart.updateOne(
    { _id: hold.owner.cartId, "items._id": hold.owner.id, "items.reservationId": hold._id },
    { $set: { "items.$.reservationId": null, "items.$.reservedQty": 0, "items.$.warehouseId": null } },
    withSession(session)
  );
}

/** Release a cart line hold (and clear the line's pointer). No-op when it already moved. */
export async function releaseCartHold(reservationId, { session, note = "cart" } = {}) {
  if (!reservationId) return null;
  return moveReservation({ reservationId, from: "held", to: "released", note, session, extraFilter: { "owner.type": "cart" } });
}

/**
 * Release expired cart holds. Each hold is released in its own transaction with a conditional
 * status flip, so two job runs (or instances) cannot double-release.
 */
export async function releaseExpiredHolds({ now = new Date(), limit = 200 } = {}) {
  const expired = await StockReservation.find({ status: "held", "owner.type": "cart", expiresAt: { $ne: null, $lte: now } })
    .sort({ expiresAt: 1 })
    .limit(limit)
    .lean();
  let released = 0;
  for (const hold of expired) {
    try {
      const moved = await withTransaction(async (session) => {
        const result = await moveReservation({
          reservationId: hold._id,
          from: "held",
          to: "released",
          note: "cart hold expired",
          session,
          extraFilter: { "owner.type": "cart", expiresAt: { $ne: null, $lte: now } },
        });
        if (result) await clearCartPointer(hold, session);
        return result;
      });
      if (moved) released += 1;
    } catch (err) {
      console.error("release expired hold", String(hold._id), err.message);
    }
  }
  return released;
}

/* -------------------------------------------------------------- read paths */

export async function availableForVariant(variantId) {
  const rows = await Inventory.aggregate([
    { $match: { variantId: oid(variantId) || variantId, archived: { $ne: true } } },
    { $group: { _id: "$variantId", available: { $sum: "$available" }, reserved: { $sum: "$reserved" } } },
  ]);
  return rows[0] || { available: 0, reserved: 0 };
}

/**
 * Pick one warehouse that can ship `qty` on its own (checkout reserves from a single warehouse).
 * Prefers a postal-code match among warehouses with enough stock, then the fullest one.
 * `creditByWarehouse` adds units the caller already holds there.
 */
export async function pickWarehouseForVariant(tenantId, variantId, preferredPostal, qty = 1, creditByWarehouse = null, session = null) {
  const creditOf = (row) => {
    const id = String(row.warehouseId?._id || row.warehouseId || "");
    if (!creditByWarehouse || !id) return 0;
    return creditByWarehouse.get?.(id) || creditByWarehouse[id] || 0;
  };
  const effective = (row) => (row.available || 0) + creditOf(row);
  const stocks = await Inventory.find({ tenantId, variantId, archived: { $ne: true } }, null, withSession(session)).populate(
    "warehouseId"
  );
  const usable = stocks.filter((row) => row.warehouseId?.status !== "inactive" && effective(row) > 0);
  if (!usable.length) return null;
  const sorted = usable.sort((a, b) => effective(b) - effective(a));
  const enough = sorted.filter((row) => effective(row) >= qty);
  if (preferredPostal) {
    const match = enough.find((s) => s.warehouseId?.postalCode === preferredPostal);
    if (match) return match;
  }
  return enough[0] || sorted[0];
}

/* ------------------------------------------- legacy names (kept for callers) */

/** @deprecated anonymous counters; use reserve(). Kept only for scripts that still import it. */
export async function reserveStock({ tenantId, warehouseId, variantId, qty, reference, session, owner }) {
  return reserve({
    tenantId,
    warehouseId,
    variantId,
    qty,
    reference,
    session,
    owner: owner || { type: "order", id: new mongoose.Types.ObjectId() },
  });
}
