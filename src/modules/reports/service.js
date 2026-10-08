import { Order } from "../orders/order.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { User } from "../users/user.model.js";
import { Product } from "../catalog/product.model.js";
import { Inventory } from "../inventory/inventory.model.js";
import { Coupon } from "../pricing/coupon.model.js";
import { Conversation } from "../chat/conversation.model.js";
import { CustomerLedger, LedgerEntry } from "../ledger/ledger.model.js";
import { presentLedger } from "../ledger/service.js";
import { AppError } from "../../utils/AppError.js";
import { asObjectId } from "../../middleware/tenantScope.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { Role } from "../rbac/role.model.js";
import { SYSTEM_ROLES } from "../../config/constants.js";
import { revenueMatch, revenueGroupFields, revenueSummary, NON_REVENUE_STATUSES, ONLINE_METHODS } from "./revenue.js";
import { startOfDay, addDays, dayKey, parseBound, mongoDay, dayList, BUSINESS_TZ } from "./time.js";

/** Spreadsheet formula injection: text starting with = + - @ tab or CR is prefixed with '. */
function csvCell(v) {
  const text = String(v ?? "");
  const safe = typeof v === "string" && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csv(rows, headers) {
  const line = (arr) => arr.map(csvCell).join(",");
  return [line(headers), ...rows.map((r) => line(headers.map((h) => r[h])))].join("\n");
}

function oid(id) {
  return asObjectId(id) || id;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Percentage change; null when there is no previous value to compare with. */
function pct(current, previous) {
  if (!previous) return null;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

/** Users that still exist (soft-deleted accounts excluded). */
const LIVE_USER = { status: { $ne: "deleted" }, deletedAt: null };

/** Same predicate as revenueMatch(), usable inside aggregation expressions. */
const IS_REVENUE_EXPR = {
  $and: [
    { $not: [{ $in: ["$status", NON_REVENUE_STATUSES] }] },
    { $not: [{ $and: [{ $in: ["$paymentMethod", ONLINE_METHODS] }, { $ne: ["$paymentStatus", "paid"] }] }] },
  ],
};

const MAX_RANGE_DAYS = 731;

/**
 * Report range from `from` / `to` ("YYYY-MM-DD" = IST calendar day, or ISO timestamps) and/or
 * `days` (counted back from `to`, default today). `explicit` is false when the caller gave none.
 */
export function resolveRange(query = {}, defaultDays = 30) {
  const explicit = Boolean(query.from || query.to || query.days);
  const to = query.to ? parseBound(query.to, true) : new Date();
  let from;
  if (query.from) {
    from = parseBound(query.from);
  } else {
    const n = Math.min(366, Math.max(1, Number(query.days) || defaultDays));
    from = startOfDay(addDays(dayKey(to), -(n - 1)));
  }
  if (from > to) throw new AppError(400, "from must be before to", "VALIDATION_ERROR");
  const days = dayList(from, to).length;
  if (days > MAX_RANGE_DAYS) throw new AppError(400, `Range is limited to ${MAX_RANGE_DAYS} days`, "VALIDATION_ERROR");
  return { from, to, days, explicit };
}

/** The range of equal length immediately before `range`. */
export function previousRange(range) {
  const from = startOfDay(addDays(dayKey(range.from), -range.days));
  return { from, to: new Date(range.from.getTime() - 1), days: range.days };
}

function createdIn(range) {
  return { createdAt: { $gte: range.from, $lte: range.to } };
}

function periodShape(range, summary) {
  return {
    days: range.days,
    from: range.from,
    to: range.to,
    orders: summary.count,
    gmv: summary.gmv,
    aov: summary.aov,
    netSales: summary.netSales,
    fees: summary.fees,
  };
}

async function buyerRoleId() {
  const role = await Role.findOne({ slug: SYSTEM_ROLES.BUYER, isSystem: true }).select("_id").lean();
  return role?._id || null;
}

export async function platformOverview() {
  const buyerRole = await buyerRoleId();
  const [tenants, users, buyers, products, orders, lowStock, openChats] = await Promise.all([
    Tenant.countDocuments({ status: { $in: ["active", "trial"] } }),
    User.countDocuments(LIVE_USER),
    User.countDocuments(buyerRole ? { ...LIVE_USER, roleId: buyerRole } : { _id: null }),
    Product.countDocuments({ status: "published" }),
    Order.aggregate([{ $match: revenueMatch() }, { $group: { _id: null, ...revenueGroupFields() } }]),
    Inventory.countDocuments({ archived: { $ne: true }, $expr: { $lte: ["$available", "$lowStockThreshold"] } }),
    Conversation.countDocuments({ status: { $in: ["unassigned", "assigned", "waiting_customer"] } }),
  ]);
  const revenue = revenueSummary(orders[0]);
  return {
    tenants,
    users,
    buyers,
    products,
    orders: revenue.count,
    gmv: revenue.gmv,
    aov: revenue.aov,
    netSales: revenue.netSales,
    fees: revenue.fees,
    lowStock,
    openChats,
    timezone: BUSINESS_TZ,
  };
}

/**
 * Store dashboard. `period` is the requested range (from/to/days, default the last 30 IST days)
 * and `previous` the range of equal length before it. With an explicit range, byStatus, topSkus,
 * customers, fillRate and cancelRate cover that range (`scope: "range"`); without one they are
 * lifetime figures (`scope: "lifetime"`). orders/gmv/aov at the top level are always lifetime.
 */
export async function tenantOverview(tenantId, query = {}) {
  if (!tenantId) throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  const id = oid(tenantId);
  const match = { tenantId: id };
  const range = resolveRange(query, 30);
  const prevRange = previousRange(range);
  const scoped = range.explicit ? { ...match, ...createdIn(range) } : match;

  const [
    sales,
    period,
    previous,
    byStatus,
    topSkus,
    lowStock,
    lowStockCount,
    coupons,
    openChats,
    products,
    publishedProducts,
    customers,
  ] = await Promise.all([
    Order.aggregate([{ $match: revenueMatch(match) }, { $group: { _id: null, ...revenueGroupFields() } }]),
    Order.aggregate([{ $match: revenueMatch({ ...match, ...createdIn(range) }) }, { $group: { _id: null, ...revenueGroupFields() } }]),
    Order.aggregate([{ $match: revenueMatch({ ...match, ...createdIn(prevRange) }) }, { $group: { _id: null, ...revenueGroupFields() } }]),
    Order.aggregate([{ $match: scoped }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    Order.aggregate([
      { $match: revenueMatch(scoped) },
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
    Inventory.find({ tenantId: id, archived: { $ne: true }, $expr: { $lte: ["$available", "$lowStockThreshold"] } })
      .populate({ path: "variantId", select: "sku productId", populate: { path: "productId", select: "name" } })
      .limit(20)
      .lean(),
    Inventory.countDocuments({ tenantId: id, archived: { $ne: true }, $expr: { $lte: ["$available", "$lowStockThreshold"] } }),
    Coupon.find({ tenantId: id }).select("code redemptionCount status").lean(),
    Conversation.countDocuments({ tenantId: id, status: { $in: ["unassigned", "assigned", "waiting_customer"] } }),
    Product.countDocuments({ tenantId: id, status: { $ne: "archived" } }),
    Product.countDocuments({ tenantId: id, status: "published" }),
    Order.distinct("buyerId", scoped),
  ]);

  const statusMap = Object.fromEntries((byStatus || []).map((s) => [s._id, s.count]));
  const delivered = statusMap.delivered || 0;
  const cancelled = (statusMap.cancelled || 0) + (statusMap.refunded || 0);
  const totalOrders = Object.values(statusMap).reduce((a, b) => a + b, 0);
  const fillDenom = Math.max(1, totalOrders - (statusMap.pending || 0));
  const total = revenueSummary(sales[0]);
  const cur = revenueSummary(period[0]);
  const prev = revenueSummary(previous[0]);

  return {
    orders: total.count,
    gmv: total.gmv,
    aov: total.aov,
    netSales: total.netSales,
    fees: total.fees,
    timezone: BUSINESS_TZ,
    scope: range.explicit ? "range" : "lifetime",
    products,
    publishedProducts,
    customers: customers.length,
    lowStockCount,
    openChats,
    fillRate: Number(((delivered / fillDenom) * 100).toFixed(1)),
    cancelRate: Number(((cancelled / Math.max(1, totalOrders)) * 100).toFixed(1)),
    byStatus: statusMap,
    period: periodShape(range, cur),
    previous: periodShape(prevRange, prev),
    changes: {
      orders: pct(cur.count, prev.count),
      gmv: pct(cur.gmv, prev.gmv),
      aov: pct(cur.aov, prev.aov),
    },
    topSkus,
    lowStock,
    coupons,
  };
}

/**
 * Daily revenue per IST business day in the range, zero-filled. Accepts a range from
 * resolveRange() or (legacy) a number of days ending today.
 */
export async function salesTrend(tenantId, rangeOrDays = 30) {
  const range = typeof rangeOrDays === "object" && rangeOrDays ? rangeOrDays : resolveRange({ days: rangeOrDays || 30 });
  const base = createdIn(range);
  if (tenantId) base.tenantId = oid(tenantId);
  const rows = await Order.aggregate([
    { $match: revenueMatch(base) },
    { $group: { _id: mongoDay("$createdAt"), ...revenueGroupFields() } },
    { $sort: { _id: 1 } },
  ]);
  const byDay = new Map(rows.map((r) => [r._id, r]));
  return dayList(range.from, range.to).map((day) => {
    const s = revenueSummary(byDay.get(day));
    return { _id: day, orders: s.count, gmv: s.gmv, aov: s.aov, netSales: s.netSales, fees: s.fees.total };
  });
}

/* ---------------------------------------------------------------- tenants */

const TENANT_SORTS = ["gmv", "ordersCount", "staffCount", "name", "createdAt", "aov"];

/**
 * Platform: per-tenant stats for a range. Query: from/to/days (default 30 days), q (name/slug),
 * status, sort (gmv|ordersCount|staffCount|aov|name|createdAt, default gmv), order, page/limit.
 * Row: { tenantId, name, slug, status, createdAt, staffCount, ordersCount, totalOrders, gmv, aov, netSales }.
 */
export async function tenantsSummary(query = {}) {
  const range = resolveRange(query, 30);
  const { page, limit, skip } = paginate(query);
  const filter = {};
  if (query.status) filter.status = { $in: String(query.status).split(",").map((s) => s.trim()).filter(Boolean) };
  if (query.q && String(query.q).trim()) {
    const rx = new RegExp(escapeRegex(String(query.q).trim().slice(0, 100)), "i");
    filter.$or = [{ name: rx }, { slug: rx }];
  }
  const sort = TENANT_SORTS.includes(String(query.sort)) ? String(query.sort) : "gmv";
  const dir = String(query.order || (sort === "name" ? "asc" : "desc")).toLowerCase() === "asc" ? 1 : -1;

  const tenants = await Tenant.find(filter).select("name slug status createdAt").lean();
  const ids = tenants.map((t) => t._id);
  const [revenue, allOrders, staff] = await Promise.all([
    Order.aggregate([
      { $match: revenueMatch({ tenantId: { $in: ids }, ...createdIn(range) }) },
      { $group: { _id: "$tenantId", ...revenueGroupFields() } },
    ]),
    Order.aggregate([{ $match: { tenantId: { $in: ids }, ...createdIn(range) } }, { $group: { _id: "$tenantId", n: { $sum: 1 } } }]),
    User.aggregate([{ $match: { ...LIVE_USER, tenantId: { $in: ids } } }, { $group: { _id: "$tenantId", n: { $sum: 1 } } }]),
  ]);
  const revBy = new Map(revenue.map((r) => [String(r._id), revenueSummary(r)]));
  const allBy = new Map(allOrders.map((r) => [String(r._id), r.n]));
  const staffBy = new Map(staff.map((r) => [String(r._id), r.n]));
  const rows = tenants.map((t) => {
    const key = String(t._id);
    const rev = revBy.get(key) || revenueSummary(null);
    return {
      tenantId: t._id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      createdAt: t.createdAt,
      staffCount: staffBy.get(key) || 0,
      ordersCount: rev.count,
      totalOrders: allBy.get(key) || 0,
      gmv: rev.gmv,
      aov: rev.aov,
      netSales: rev.netSales,
    };
  });
  rows.sort((a, b) => {
    const av = a[sort];
    const bv = b[sort];
    if (av === bv) return String(a.name).localeCompare(String(b.name));
    if (sort === "name") return dir * String(av).localeCompare(String(bv));
    return dir * ((av instanceof Date ? av.getTime() : av) > (bv instanceof Date ? bv.getTime() : bv) ? 1 : -1);
  });
  const totals = rows.reduce(
    (acc, r) => ({ staffCount: acc.staffCount + r.staffCount, ordersCount: acc.ordersCount + r.ordersCount, gmv: Math.round((acc.gmv + r.gmv) * 100) / 100 }),
    { staffCount: 0, ordersCount: 0, gmv: 0 }
  );
  return {
    ...paginated(rows.slice(skip, skip + limit), rows.length, { page, limit }),
    range: { from: range.from, to: range.to, days: range.days },
    totals,
  };
}

/* -------------------------------------------------------------- customers */

const CUSTOMER_SORTS = ["spend", "orders", "lastOrderAt", "name"];

function customerAddress(user, row = {}) {
  return [
    user?.profile?.addressLine1,
    row.city || user?.profile?.location?.city,
    row.state || user?.profile?.location?.state,
    user?.profile?.location?.postalCode,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * A store's customers: buyers who ordered from it, plus (without a date range) buyers whose home
 * store it is. Query: q (name/email/phone/company), sort (spend|orders|lastOrderAt|name, default
 * spend), order (asc|desc), from/to/days (only orders in range; home-store buyers without orders
 * in range are left out), page/limit. `all: true` returns up to `cap` rows (exports).
 */
export async function tenantCustomers(tenantId, query = {}, { all = false, cap = 1000 } = {}) {
  if (!tenantId) throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  const id = oid(tenantId);
  const range = query.from || query.to || query.days ? resolveRange(query, 30) : null;
  const orderMatch = range ? { tenantId: id, ...createdIn(range) } : { tenantId: id };
  let grouped = await Order.aggregate([
    { $match: orderMatch },
    { $sort: { createdAt: 1 } },
    {
      $group: {
        _id: "$buyerId",
        orders: { $sum: 1 },
        revenueOrders: { $sum: { $cond: [IS_REVENUE_EXPR, 1, 0] } },
        spend: { $sum: { $cond: [IS_REVENUE_EXPR, "$total", 0] } },
        firstOrderAt: { $min: "$createdAt" },
        lastOrderAt: { $max: "$createdAt" },
        city: { $last: "$addressSnapshot.city" },
        state: { $last: "$addressSnapshot.state" },
        buyerName: { $last: "$buyerSnapshot.name" },
      },
    },
  ]);
  if (!range) {
    const buyerRole = await buyerRoleId();
    const known = new Set(grouped.map((r) => String(r._id)));
    const home = await User.find({ ...LIVE_USER, homeTenantId: id, ...(buyerRole ? { roleId: buyerRole } : {}) })
      .select("_id name")
      .lean();
    for (const u of home) {
      if (known.has(String(u._id))) continue;
      grouped.push({ _id: u._id, orders: 0, revenueOrders: 0, spend: 0, firstOrderAt: null, lastOrderAt: null, buyerName: u.name });
    }
  }

  const ids = grouped.map((r) => r._id).filter(Boolean);
  const users = await User.find({ _id: { $in: ids } }).select("name email phone profile status homeTenantId createdAt deletedAt").lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  if (query.q && String(query.q).trim()) {
    const rx = new RegExp(escapeRegex(String(query.q).trim().slice(0, 100)), "i");
    grouped = grouped.filter((r) => {
      const u = byId.get(String(r._id));
      return [u?.name, u?.email, u?.phone, u?.profile?.company, r.buyerName].some((v) => v && rx.test(v));
    });
  }

  const sort = CUSTOMER_SORTS.includes(String(query.sort)) ? String(query.sort) : "spend";
  const dir = String(query.order || (sort === "name" ? "asc" : "desc")).toLowerCase() === "asc" ? 1 : -1;
  const nameOf = (r) => byId.get(String(r._id))?.name || r.buyerName || "";
  grouped.sort((a, b) => {
    if (sort === "name") return dir * nameOf(a).localeCompare(nameOf(b));
    const av = sort === "lastOrderAt" ? new Date(a.lastOrderAt || 0).getTime() : a[sort] || 0;
    const bv = sort === "lastOrderAt" ? new Date(b.lastOrderAt || 0).getTime() : b[sort] || 0;
    if (av === bv) return nameOf(a).localeCompare(nameOf(b));
    return dir * (av > bv ? 1 : -1);
  });

  const total = grouped.length;
  let page = 1;
  let limit = cap;
  let slice;
  if (all) {
    slice = grouped.slice(0, cap);
  } else {
    const p = paginate(query);
    page = p.page;
    limit = p.limit;
    slice = grouped.slice(p.skip, p.skip + p.limit);
  }
  const ledgers = await CustomerLedger.find({ tenantId: id, userId: { $in: slice.map((r) => r._id) } }).lean();
  const ledgerBy = new Map(ledgers.map((l) => [String(l.userId), presentLedger(l)]));
  const data = slice.map((row) => {
    const user = byId.get(String(row._id));
    const account = ledgerBy.get(String(row._id));
    return {
      id: row._id,
      name: user?.name || row.buyerName || "Unknown buyer",
      email: user?.email || "",
      phone: user?.phone || "",
      company: user?.profile?.company || "",
      gstin: user?.profile?.gstin || "",
      address: customerAddress(user, row),
      city: row.city || user?.profile?.location?.city || "",
      state: row.state || user?.profile?.location?.state || "",
      orders: row.orders,
      revenueOrders: row.revenueOrders,
      spend: Math.round((row.spend || 0) * 100) / 100,
      aov: row.revenueOrders ? Math.round((row.spend / row.revenueOrders) * 100) / 100 : 0,
      firstOrderAt: row.firstOrderAt,
      lastOrderAt: row.lastOrderAt,
      homeStore: String(user?.homeTenantId || "") === String(id),
      status: user?.status || "active",
      ledger: account
        ? { creditLimit: account.creditLimit, outstanding: account.outstanding, available: account.available, advance: account.advance }
        : null,
    };
  });
  return paginated(data, total, { page, limit });
}

/**
 * One buyer as seen by a store: profile, order stats with the store, a page of their orders
 * (query page/limit) and their ledger account. Visible to the store's staff when the buyer has
 * ordered from the store or the store is their home store; otherwise 404.
 */
export async function customerDetail(tenantId, userId, query = {}) {
  if (!tenantId) throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  const tid = oid(tenantId);
  const uid = asObjectId(userId);
  if (!uid) throw new AppError(400, "Invalid id", "INVALID_ID");
  const user = await User.findById(uid).select("name email phone profile status homeTenantId createdAt lastLoginAt deletedAt").lean();
  const ordered = user ? await Order.exists({ tenantId: tid, buyerId: uid }) : null;
  if (!user || (!ordered && String(user.homeTenantId || "") !== String(tid))) {
    throw new AppError(404, "Customer not found", "NOT_FOUND");
  }
  const { page, limit, skip } = paginate(query);
  const match = { tenantId: tid, buyerId: uid };
  const [stats, byStatus, orders, totalOrders, ledger, entries, refunds] = await Promise.all([
    Order.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          revenueOrders: { $sum: { $cond: [IS_REVENUE_EXPR, 1, 0] } },
          spend: { $sum: { $cond: [IS_REVENUE_EXPR, "$total", 0] } },
          firstOrderAt: { $min: "$createdAt" },
          lastOrderAt: { $max: "$createdAt" },
        },
      },
    ]),
    Order.aggregate([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    Order.find(match)
      .select("orderNumber status paymentStatus paymentMethod total createdAt items.qty couponCode returnRequest.status")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Order.countDocuments(match),
    CustomerLedger.findOne({ tenantId: tid, userId: uid }).lean(),
    LedgerEntry.find({ tenantId: tid, userId: uid }).sort({ createdAt: -1 }).limit(10).lean(),
    Order.aggregate([
      { $match: { ...match, status: "refunded" } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$total" } } },
    ]),
  ]);
  const s = stats[0] || {};
  const spend = Math.round((s.spend || 0) * 100) / 100;
  return {
    customer: {
      id: user._id,
      name: user.name || "",
      email: user.email || "",
      phone: user.phone || "",
      company: user.profile?.company || "",
      gstin: user.profile?.gstin || "",
      address: customerAddress(user),
      location: user.profile?.location || {},
      status: user.status,
      joinedAt: user.createdAt,
      homeStore: String(user.homeTenantId || "") === String(tid),
    },
    stats: {
      orders: s.orders || 0,
      revenueOrders: s.revenueOrders || 0,
      spend,
      aov: s.revenueOrders ? Math.round((spend / s.revenueOrders) * 100) / 100 : 0,
      firstOrderAt: s.firstOrderAt || null,
      lastOrderAt: s.lastOrderAt || null,
      byStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.count])),
      refunded: { count: refunds[0]?.count || 0, amount: Math.round((refunds[0]?.amount || 0) * 100) / 100 },
    },
    orders: paginated(
      orders.map((o) => ({
        _id: o._id,
        orderNumber: o.orderNumber,
        status: o.status,
        paymentStatus: o.paymentStatus,
        paymentMethod: o.paymentMethod,
        total: o.total,
        grandTotal: o.total,
        items: (o.items || []).reduce((n, i) => n + (i.qty || 0), 0),
        couponCode: o.couponCode || "",
        returnStatus: o.returnRequest?.status || null,
        createdAt: o.createdAt,
      })),
      totalOrders,
      { page, limit }
    ),
    ledger: ledger ? { ...presentLedger(ledger), entries } : null,
  };
}

/* -------------------------------------------------------------------- csv */

export function toCsv(kind, rows) {
  if (kind === "orders") {
    return csv(
      rows.map((r) => ({
        orderNumber: r.orderNumber,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        status: r.status,
        paymentMethod: r.paymentMethod,
        paymentStatus: r.paymentStatus,
        buyer: r.buyerId?.name || r.buyerSnapshot?.name || "",
        buyerEmail: r.buyerId?.email || r.buyerSnapshot?.email || "",
        store: r.tenantId?.name || "",
        items: Array.isArray(r.items) ? r.items.reduce((n, i) => n + (i.qty || 0), 0) : "",
        total: r.total,
        refundStatus: (r.refunds || []).map((x) => x.status).join("|"),
        poNumber: r.poNumber || "",
      })),
      ["orderNumber", "createdAt", "status", "paymentMethod", "paymentStatus", "buyer", "buyerEmail", "store", "items", "total", "refundStatus", "poNumber"]
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
        damaged: r.damaged || 0,
        incoming: r.incoming || 0,
        lowStockThreshold: r.lowStockThreshold || 0,
      })),
      ["sku", "product", "warehouse", "available", "reserved", "committed", "damaged", "incoming", "lowStockThreshold"]
    );
  }
  if (kind === "customers") {
    return csv(
      rows.map((r) => ({ ...r, outstanding: r.ledger?.outstanding ?? "", creditLimit: r.ledger?.creditLimit ?? "" })),
      ["name", "email", "phone", "company", "city", "orders", "spend", "aov", "lastOrderAt", "creditLimit", "outstanding"]
    );
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
