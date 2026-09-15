import mongoose from "mongoose";
import { Order } from "../orders/order.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { User } from "../users/user.model.js";
import { Product } from "../catalog/product.model.js";
import { Inventory } from "../inventory/inventory.model.js";
import { Coupon } from "../pricing/coupon.model.js";
import { Conversation } from "../chat/conversation.model.js";
import { AppError } from "../../utils/AppError.js";
import { asObjectId } from "../../middleware/tenantScope.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { Role } from "../rbac/role.model.js";
import { SYSTEM_ROLES } from "../../config/constants.js";

function csv(rows, headers) {
  const line = (arr) => arr.map((v) => `"${String(v ?? "").replaceAll('"', '""')}"`).join(",");
  return [line(headers), ...rows.map((r) => line(headers.map((h) => r[h])))].join("\n");
}

function oid(id) {
  return asObjectId(id) || id;
}

function pct(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

export async function platformOverview() {
  const buyerRole = await Role.findOne({ slug: SYSTEM_ROLES.BUYER, isSystem: true }).select("_id");
  const [tenants, users, buyers, products, orders, lowStock, openChats] = await Promise.all([
    Tenant.countDocuments({ status: { $in: ["active", "trial"] } }),
    User.countDocuments({}),
    User.countDocuments(buyerRole ? { roleId: buyerRole._id } : { _id: null }),
    Product.countDocuments({ status: "published" }),
    Order.aggregate([
      { $match: { status: { $nin: ["cancelled"] } } },
      { $group: { _id: null, count: { $sum: 1 }, gmv: { $sum: "$total" } } },
    ]),
    Inventory.countDocuments({ $expr: { $lte: ["$available", "$lowStockThreshold"] } }),
    Conversation.countDocuments({ status: { $in: ["unassigned", "assigned", "waiting_customer"] } }),
  ]);
  return {
    tenants,
    users,
    buyers,
    products,
    orders: orders[0]?.count || 0,
    gmv: orders[0]?.gmv || 0,
    lowStock,
    openChats,
  };
}

export async function tenantOverview(tenantId) {
  if (!tenantId) throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  const id = oid(tenantId);
  const match = { tenantId: id };
  const since = daysAgo(30);
  const prevSince = daysAgo(60);

  const [
    sales,
    period,
    previous,
    byStatus,
    topSkus,
    lowStock,
    coupons,
    openChats,
    products,
    publishedProducts,
    customers,
  ] = await Promise.all([
    Order.aggregate([
      { $match: { ...match, status: { $nin: ["cancelled", "refunded"] } } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          gmv: { $sum: "$total" },
          aov: { $avg: "$total" },
        },
      },
    ]),
    Order.aggregate([
      { $match: { ...match, createdAt: { $gte: since }, status: { $nin: ["cancelled", "refunded"] } } },
      { $group: { _id: null, count: { $sum: 1 }, gmv: { $sum: "$total" } } },
    ]),
    Order.aggregate([
      {
        $match: {
          ...match,
          createdAt: { $gte: prevSince, $lt: since },
          status: { $nin: ["cancelled", "refunded"] },
        },
      },
      { $group: { _id: null, count: { $sum: 1 }, gmv: { $sum: "$total" } } },
    ]),
    Order.aggregate([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    Order.aggregate([
      { $match: { ...match, status: { $nin: ["cancelled", "refunded"] } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.sku",
          name: { $first: "$items.name" },
          qty: { $sum: "$items.qty" },
          revenue: { $sum: "$items.lineTotal" },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 10 },
    ]),
    Inventory.find({ tenantId: id, $expr: { $lte: ["$available", "$lowStockThreshold"] } })
      .populate({ path: "variantId", select: "sku productId", populate: { path: "productId", select: "name" } })
      .limit(20)
      .lean(),
    Coupon.find({ tenantId: id }).select("code redemptionCount status").lean(),
    Conversation.countDocuments({ tenantId: id, status: { $in: ["unassigned", "assigned", "waiting_customer"] } }),
    Product.countDocuments({ tenantId: id, status: { $ne: "archived" } }),
    Product.countDocuments({ tenantId: id, status: "published" }),
    Order.distinct("buyerId", match),
  ]);

  const statusMap = Object.fromEntries((byStatus || []).map((s) => [s._id, s.count]));
  const delivered = statusMap.delivered || 0;
  const cancelled = (statusMap.cancelled || 0) + (statusMap.refunded || 0);
  const totalOrders = Object.values(statusMap).reduce((a, b) => a + b, 0);
  const fillDenom = Math.max(1, totalOrders - (statusMap.pending || 0));
  const periodOrders = period[0]?.count || 0;
  const periodGmv = period[0]?.gmv || 0;
  const prevOrders = previous[0]?.count || 0;
  const prevGmv = previous[0]?.gmv || 0;

  return {
    orders: sales[0]?.count || 0,
    gmv: sales[0]?.gmv || 0,
    aov: sales[0]?.aov || 0,
    products,
    publishedProducts,
    customers: customers.length,
    lowStockCount: lowStock.length,
    openChats,
    fillRate: Number(((delivered / fillDenom) * 100).toFixed(1)),
    cancelRate: Number(((cancelled / Math.max(1, totalOrders)) * 100).toFixed(1)),
    byStatus: statusMap,
    period: { days: 30, orders: periodOrders, gmv: periodGmv },
    previous: { days: 30, orders: prevOrders, gmv: prevGmv },
    changes: {
      orders: pct(periodOrders, prevOrders),
      gmv: pct(periodGmv, prevGmv),
    },
    topSkus,
    lowStock,
    coupons,
  };
}

export async function salesTrend(tenantId, days = 30) {
  const since = daysAgo(days);
  const match = { createdAt: { $gte: since }, status: { $nin: ["cancelled", "refunded"] } };
  if (tenantId) match.tenantId = oid(tenantId);
  return Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        orders: { $sum: 1 },
        gmv: { $sum: "$total" },
      },
    },
    { $sort: { _id: 1 } },
  ]);
}

export async function tenantCustomers(tenantId, query = {}) {
  if (!tenantId) throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  const { page, limit, skip } = paginate(query);
  const id = oid(tenantId);
  let grouped = await Order.aggregate([
    { $match: { tenantId: id } },
    {
      $group: {
        _id: "$buyerId",
        orders: { $sum: 1 },
        spend: {
          $sum: {
            $cond: [{ $in: ["$status", ["cancelled", "refunded"]] }, 0, "$total"],
          },
        },
        lastOrderAt: { $max: "$createdAt" },
        city: { $last: "$addressSnapshot.city" },
        state: { $last: "$addressSnapshot.state" },
      },
    },
    { $sort: { spend: -1 } },
  ]);

  if (query.q) {
    const rx = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const matching = await User.find({
      _id: { $in: grouped.map((r) => r._id).filter(Boolean) },
      $or: [{ name: rx }, { email: rx }, { phone: rx }],
    }).select("_id");
    const allow = new Set(matching.map((u) => String(u._id)));
    grouped = grouped.filter((r) => allow.has(String(r._id)));
  }

  const total = grouped.length;
  const slice = grouped.slice(skip, skip + limit);
  const users = await User.find({ _id: { $in: slice.map((r) => r._id) } })
    .select("name email phone profile status")
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const data = slice.map((row) => {
    const user = byId.get(String(row._id));
    return {
      id: row._id,
      name: user?.name || "Unknown buyer",
      email: user?.email || "",
      phone: user?.phone || "",
      company: user?.profile?.company || "",
      city: row.city || user?.profile?.location?.city || "",
      state: row.state || user?.profile?.location?.state || "",
      orders: row.orders,
      spend: row.spend,
      lastOrderAt: row.lastOrderAt,
      status: user?.status || "active",
    };
  });
  return paginated(data, total, { page, limit });
}

export function toCsv(kind, rows) {
  if (kind === "orders") {
    return csv(
      rows.map((r) => ({
        orderNumber: r.orderNumber,
        status: r.status,
        buyer: r.buyerId?.name || r.buyerId?.email || "",
        items: Array.isArray(r.items) ? r.items.reduce((n, i) => n + (i.qty || 0), 0) : "",
        total: r.total,
        createdAt: r.createdAt,
      })),
      ["orderNumber", "status", "buyer", "items", "total", "createdAt"]
    );
  }
  if (kind === "inventory") {
    return csv(
      rows.map((r) => ({
        sku: r.sku,
        product: r.variantId?.productId?.name || "",
        warehouse: r.warehouseId?.code || r.warehouseId?.name || "",
        available: r.available,
        reserved: r.reserved,
        committed: r.committed,
      })),
      ["sku", "product", "warehouse", "available", "reserved", "committed"]
    );
  }
  if (kind === "customers") {
    return csv(rows, ["name", "email", "phone", "company", "city", "orders", "spend", "lastOrderAt"]);
  }
  if (kind === "sales" || kind === "skus") {
    const headers = Object.keys(rows[0] || { value: "" });
    return csv(
      rows.map((r) => {
        const out = { ...r };
        if (out._id != null && out.day == null) out.day = out._id;
        return out;
      }),
      headers.includes("_id") ? ["day", ...headers.filter((h) => h !== "_id")] : headers
    );
  }
  return csv(rows, Object.keys(rows[0] || { value: "" }));
}

export { csv };
