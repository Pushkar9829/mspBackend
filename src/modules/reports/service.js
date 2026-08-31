import { Order } from "../orders/order.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { User } from "../users/user.model.js";
import { Product } from "../catalog/product.model.js";
import { Inventory } from "../inventory/inventory.model.js";
import { Coupon } from "../pricing/coupon.model.js";
import { Conversation } from "../chat/conversation.model.js";
import { AppError } from "../../utils/AppError.js";

function csv(rows, headers) {
  const line = (arr) => arr.map((v) => `"${String(v ?? "").replaceAll('"', '""')}"`).join(",");
  return [line(headers), ...rows.map((r) => line(headers.map((h) => r[h])))].join("\n");
}

export async function platformOverview() {
  const [tenants, buyers, products, orders, lowStock, openChats] = await Promise.all([
    Tenant.countDocuments({ status: { $in: ["active", "trial"] } }),
    User.countDocuments({}),
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
  const match = { tenantId };
  const [sales, topSkus, lowStock, coupons, openChats] = await Promise.all([
    Order.aggregate([
      { $match: { ...match, status: { $nin: ["cancelled"] } } },
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
      { $match: { ...match, status: { $nin: ["cancelled"] } } },
      { $unwind: "$items" },
      { $group: { _id: "$items.sku", qty: { $sum: "$items.qty" }, revenue: { $sum: "$items.lineTotal" } } },
      { $sort: { revenue: -1 } },
      { $limit: 10 },
    ]),
    Inventory.find({ tenantId, $expr: { $lte: ["$available", "$lowStockThreshold"] } }).limit(20),
    Coupon.find({ tenantId }).select("code redemptionCount status"),
    Conversation.countDocuments({ tenantId, status: { $in: ["unassigned", "assigned", "waiting_customer"] } }),
  ]);
  return {
    orders: sales[0]?.count || 0,
    gmv: sales[0]?.gmv || 0,
    aov: sales[0]?.aov || 0,
    topSkus,
    lowStock,
    coupons,
    openChats,
  };
}

export async function salesTrend(tenantId, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const match = { createdAt: { $gte: since }, status: { $nin: ["cancelled"] } };
  if (tenantId) match.tenantId = tenantId;
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

export function toCsv(kind, rows) {
  if (kind === "orders") {
    return csv(rows, ["orderNumber", "status", "total", "createdAt"]);
  }
  if (kind === "inventory") {
    return csv(rows, ["sku", "available", "reserved", "committed"]);
  }
  return csv(rows, Object.keys(rows[0] || { value: "" }));
}

export { csv };
