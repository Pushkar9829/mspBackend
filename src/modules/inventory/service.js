import { Warehouse } from "./warehouse.model.js";
import { Inventory } from "./inventory.model.js";
import { InventoryTransaction } from "./transaction.model.js";
import { ProductVariant } from "../catalog/variant.model.js";
import { AppError } from "../../utils/AppError.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import { emitDomain } from "../../utils/events.js";
import { paginate, paginated } from "../../utils/pagination.js";

export async function listWarehouses(req) {
  return Warehouse.find(tenantFilter(req)).sort({ name: 1 });
}

export async function createWarehouse(req, body) {
  return Warehouse.create({ ...body, tenantId: req.tenantId, code: String(body.code).toUpperCase() });
}

export async function updateWarehouse(req, id, body) {
  if (body.code) body.code = String(body.code).toUpperCase();
  const doc = await Warehouse.findOneAndUpdate({ _id: id, ...tenantFilter(req) }, body, {
    new: true,
    runValidators: true,
  });
  if (!doc) throw new AppError(404, "Warehouse not found", "NOT_FOUND");
  return doc;
}

export async function listInventory(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = tenantFilter(req);
  if (req.query.warehouseId) filter.warehouseId = req.query.warehouseId;
  if (req.query.variantId) filter.variantId = req.query.variantId;
  if (req.query.lowStock === "true") {
    filter.$expr = { $lte: ["$available", "$lowStockThreshold"] };
  }
  const [data, total] = await Promise.all([
    Inventory.find(filter)
      .populate("warehouseId", "name code")
      .populate("variantId", "sku attributes sellingPrice listPrice productId")
      .skip(skip)
      .limit(limit)
      .sort({ sku: 1 }),
    Inventory.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}

async function writeLedger({ tenantId, warehouseId, variantId, sku, reason, qty, stock, actorId, reference, note, session }) {
  const payload = {
    tenantId,
    warehouseId,
    variantId,
    sku,
    reason,
    qty,
    availableAfter: stock.available,
    reservedAfter: stock.reserved,
    committedAfter: stock.committed,
    actorId,
    reference: reference || "",
    note: note || "",
  };
  if (session) {
    await InventoryTransaction.create([payload], { session });
  } else {
    await InventoryTransaction.create(payload);
  }
}

export async function adjustStock(req, { warehouseId, variantId, reason, qty, note }) {
  const variant = await ProductVariant.findOne({ _id: variantId, ...tenantFilter(req) });
  if (!variant) throw new AppError(404, "Variant not found", "NOT_FOUND");

  let stock = await Inventory.findOne({
    tenantId: req.tenantId,
    warehouseId,
    variantId,
  });
  if (!stock) {
    stock = await Inventory.create({
      tenantId: req.tenantId,
      warehouseId,
      variantId,
      sku: variant.sku,
    });
  }

  if (reason === "inward" || reason === "adjustment" || reason === "return") {
    const next = stock.available + qty;
    if (next < 0) throw new AppError(400, "Insufficient available stock", "INSUFFICIENT_STOCK");
    stock.available = next;
  } else if (reason === "incoming") {
    const next = stock.incoming + qty;
    if (next < 0) throw new AppError(400, "Incoming cannot be negative", "INSUFFICIENT_STOCK");
    stock.incoming = next;
  } else if (reason === "damage") {
    if (stock.available < qty) throw new AppError(400, "Insufficient available stock", "INSUFFICIENT_STOCK");
    stock.available -= qty;
    stock.damaged += qty;
  } else {
    throw new AppError(400, "Unsupported adjust reason", "VALIDATION_ERROR");
  }

  await stock.save();
  await writeLedger({
    tenantId: req.tenantId,
    warehouseId,
    variantId,
    sku: variant.sku,
    reason,
    qty,
    stock,
    actorId: req.user._id,
    note,
  });

  await maybeAlertStock(stock);
  return stock;
}

export async function updateThresholds(req, id, body) {
  const stock = await Inventory.findOneAndUpdate(
    { _id: id, ...tenantFilter(req) },
    {
      ...(body.lowStockThreshold != null ? { lowStockThreshold: body.lowStockThreshold } : {}),
      ...(body.incoming != null ? { incoming: body.incoming } : {}),
    },
    { new: true, runValidators: true }
  );
  if (!stock) throw new AppError(404, "Inventory row not found", "NOT_FOUND");
  emitDomain("INVENTORY_PUBLISHED", {
    tenantId: req.tenantId,
    variantId: stock.variantId,
    sku: stock.sku,
    lowStockThreshold: stock.lowStockThreshold,
  });
  return stock;
}

async function maybeAlertStock(stock) {
  if (stock.available === 0) {
    emitDomain("OUT_OF_STOCK", {
      tenantId: stock.tenantId,
      variantId: stock.variantId,
      sku: stock.sku,
      warehouseId: stock.warehouseId,
    });
    stock.lastLowStockAlertAt = new Date();
    await stock.save();
    return;
  }
  if (stock.lowStockThreshold > 0 && stock.available <= stock.lowStockThreshold) {
    const sixHours = 6 * 60 * 60 * 1000;
    if (!stock.lastLowStockAlertAt || Date.now() - stock.lastLowStockAlertAt.getTime() > sixHours) {
      emitDomain("LOW_STOCK", {
        tenantId: stock.tenantId,
        variantId: stock.variantId,
        sku: stock.sku,
        available: stock.available,
        warehouseId: stock.warehouseId,
      });
      stock.lastLowStockAlertAt = new Date();
      await stock.save();
    }
  }
}

export async function transferStock(req, { fromWarehouseId, toWarehouseId, variantId, qty, note }) {
  if (String(fromWarehouseId) === String(toWarehouseId)) {
    throw new AppError(400, "Warehouses must differ", "VALIDATION_ERROR");
  }
  const source = await Inventory.findOneAndUpdate(
    {
      tenantId: req.tenantId,
      warehouseId: fromWarehouseId,
      variantId,
      available: { $gte: qty },
    },
    { $inc: { available: -qty } },
    { new: true }
  );
  if (!source) {
    throw new AppError(400, "Insufficient stock to transfer", "INSUFFICIENT_STOCK");
  }
  await writeLedger({
    tenantId: req.tenantId,
    warehouseId: fromWarehouseId,
    variantId,
    sku: source.sku,
    reason: "transfer_out",
    qty: -qty,
    stock: source,
    actorId: req.user._id,
    note,
  });

  try {
    let dest = await Inventory.findOneAndUpdate(
      { tenantId: req.tenantId, warehouseId: toWarehouseId, variantId },
      { $inc: { available: qty }, $setOnInsert: { sku: source.sku } },
      { new: true, upsert: true }
    );
    await writeLedger({
      tenantId: req.tenantId,
      warehouseId: toWarehouseId,
      variantId,
      sku: source.sku,
      reason: "transfer_in",
      qty,
      stock: dest,
      actorId: req.user._id,
      note,
    });
    return { from: source, to: dest };
  } catch (err) {
    await Inventory.findOneAndUpdate(
      { tenantId: req.tenantId, warehouseId: fromWarehouseId, variantId },
      { $inc: { available: qty } }
    );
    throw err;
  }
}

export async function reserveStock({ tenantId, warehouseId, variantId, qty, reference, session }) {
  const filter = {
    tenantId,
    warehouseId,
    variantId,
    available: { $gte: qty },
  };
  const update = { $inc: { available: -qty, reserved: qty } };
  const opts = { new: true };
  if (session) opts.session = session;
  const stock = await Inventory.findOneAndUpdate(filter, update, opts);
  if (!stock) throw new AppError(409, "Insufficient stock", "INSUFFICIENT_STOCK");
  await writeLedger({
    tenantId,
    warehouseId,
    variantId,
    sku: stock.sku,
    reason: "reserve",
    qty: -qty,
    stock,
    reference,
    session,
  });
  return stock;
}

export async function releaseReservation({ tenantId, warehouseId, variantId, qty, reference, session }) {
  const opts = { new: true };
  if (session) opts.session = session;
  const stock = await Inventory.findOneAndUpdate(
    { tenantId, warehouseId, variantId, reserved: { $gte: qty } },
    { $inc: { available: qty, reserved: -qty } },
    opts
  );
  if (!stock) return null;
  await writeLedger({
    tenantId,
    warehouseId,
    variantId,
    sku: stock.sku,
    reason: "release",
    qty,
    stock,
    reference,
    session,
  });
  return stock;
}

export async function commitReservation({ tenantId, warehouseId, variantId, qty, reference, session }) {
  const opts = { new: true };
  if (session) opts.session = session;
  const stock = await Inventory.findOneAndUpdate(
    { tenantId, warehouseId, variantId, reserved: { $gte: qty } },
    { $inc: { reserved: -qty, committed: qty } },
    opts
  );
  if (!stock) throw new AppError(409, "Reservation missing", "INSUFFICIENT_STOCK");
  await writeLedger({
    tenantId,
    warehouseId,
    variantId,
    sku: stock.sku,
    reason: "commit",
    qty,
    stock,
    reference,
    session,
  });
  return stock;
}

export async function restoreCommitted({ tenantId, warehouseId, variantId, qty, reference, session }) {
  const opts = { new: true };
  if (session) opts.session = session;
  const stock = await Inventory.findOneAndUpdate(
    { tenantId, warehouseId, variantId, committed: { $gte: qty } },
    { $inc: { committed: -qty, available: qty } },
    opts
  );
  if (!stock) return null;
  await writeLedger({
    tenantId,
    warehouseId,
    variantId,
    sku: stock.sku,
    reason: "return",
    qty,
    stock,
    reference,
    session,
  });
  emitDomain("STOCK_RESTORED", { tenantId, variantId, sku: stock.sku, qty, warehouseId });
  return stock;
}

export async function availableForVariant(variantId) {
  const rows = await Inventory.aggregate([
    { $match: { variantId } },
    { $group: { _id: "$variantId", available: { $sum: "$available" }, reserved: { $sum: "$reserved" } } },
  ]);
  return rows[0] || { available: 0, reserved: 0 };
}

export async function pickWarehouseForVariant(tenantId, variantId, preferredPostal) {
  const stocks = await Inventory.find({ tenantId, variantId, available: { $gt: 0 } }).populate("warehouseId");
  if (!stocks.length) return null;
  if (preferredPostal) {
    const match = stocks.find((s) => s.warehouseId?.postalCode === preferredPostal);
    if (match) return match;
  }
  return stocks.sort((a, b) => b.available - a.available)[0];
}

export async function listTransactions(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = tenantFilter(req);
  if (req.query.variantId) filter.variantId = req.query.variantId;
  const [data, total] = await Promise.all([
    InventoryTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    InventoryTransaction.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}
