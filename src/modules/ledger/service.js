import mongoose from "mongoose";
import { CustomerLedger, LedgerEntry } from "./ledger.model.js";
import { Order } from "../orders/order.model.js";
import { User } from "../users/user.model.js";
import { Role } from "../rbac/role.model.js";
import { SYSTEM_ROLES } from "../../config/constants.js";
import { AppError } from "../../utils/AppError.js";
import { withTransaction, withSession } from "../../utils/transaction.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { parseBound } from "../reports/time.js";

export const LEDGER_PAYMENT_METHODS = ["credit_terms", "purchase_order"];

export function toPaise(rupees) {
  return Math.round((Number(rupees) || 0) * 100 + (Number(rupees) >= 0 ? 1e-7 : -1e-7));
}

export function fromPaise(paise) {
  return Math.round(Number(paise) || 0) / 100;
}

function oid(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === "object" && value._id) return oid(value._id);
  return mongoose.Types.ObjectId.isValid(String(value)) ? new mongoose.Types.ObjectId(String(value)) : null;
}

/** Legacy docs only have rupee `balance`; derive paise from it on first touch. */
const BALANCE_PAISE = { $ifNull: ["$balancePaise", { $round: [{ $multiply: [{ $ifNull: ["$balance", 0] }, 100] }, 0] }] };
const ADVANCE_PAISE = { $ifNull: ["$advancePaise", 0] };
const LIMIT_PAISE = { $ifNull: ["$creditLimitPaise", 0] };

/**
 * How an entry moves money (see ledger.model.js for the accounting):
 *  - "settle": credits that pay dues (payment, reversal, positive adjustment). They restore the
 *    credit line up to the limit; anything beyond what is owed becomes advance.
 *  - "spend": debits for goods (order, negative adjustment). They use the advance first, then the
 *    credit line.
 *  - "line": the credit line itself changes (opening grant, limit change): balance moves 1:1.
 */
function movementFor(type, kind) {
  if (kind === "opening" || kind === "limit") return "line";
  return type === "credit" ? "settle" : "spend";
}

function mirrors() {
  return {
    $set: {
      balance: { $divide: ["$balancePaise", 100] },
      advance: { $divide: ["$advancePaise", 100] },
    },
  };
}

function updatePipeline(movement, paise) {
  if (movement === "settle") {
    return [
      { $set: { __total: { $add: [BALANCE_PAISE, paise] }, __limit: LIMIT_PAISE, advancePaise: ADVANCE_PAISE } },
      {
        $set: {
          balancePaise: { $min: ["$__total", { $max: ["$__limit", BALANCE_PAISE] }] },
          advancePaise: { $add: ["$advancePaise", { $max: [0, { $subtract: ["$__total", { $max: ["$__limit", BALANCE_PAISE] }] }] }] },
        },
      },
      mirrors(),
      { $unset: ["__total", "__limit"] },
    ];
  }
  if (movement === "spend") {
    return [
      { $set: { __fromAdvance: { $min: [ADVANCE_PAISE, paise] }, advancePaise: ADVANCE_PAISE } },
      {
        $set: {
          advancePaise: { $subtract: ["$advancePaise", "$__fromAdvance"] },
          balancePaise: { $subtract: [BALANCE_PAISE, { $subtract: [paise, "$__fromAdvance"] }] },
        },
      },
      mirrors(),
      { $unset: ["__fromAdvance"] },
    ];
  }
  return [
    { $set: { balancePaise: { $add: [BALANCE_PAISE, paise] }, advancePaise: ADVANCE_PAISE } },
    mirrors(),
  ];
}

function runInTx(session, fn) {
  return session ? fn(session) : withTransaction(fn);
}

export async function getOrCreateLedger(userId, tenantId = null, { session = null } = {}) {
  if (!userId) throw new AppError(400, "User required", "VALIDATION_ERROR");
  const filter = { userId: oid(userId), tenantId: oid(tenantId) };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await CustomerLedger.findOneAndUpdate(
        filter,
        { $setOnInsert: { balancePaise: 0, balance: 0, creditLimitPaise: 0, advancePaise: 0, advance: 0 } },
        withSession(session, { upsert: true, new: true, setDefaultsOnInsert: true })
      );
    } catch (err) {
      if (err?.code !== 11000 || attempt) throw err;
    }
  }
  return null;
}

export async function findLedger(userId, tenantId, session = null) {
  return CustomerLedger.findOne({ userId: oid(userId), tenantId: oid(tenantId) }, null, withSession(session));
}

/** Normalised payment reference used for the duplicate guard. */
export function paymentReferenceKey(reference) {
  return String(reference || "").trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * Move money on one account: balance/advance change and entry insert in the same transaction.
 * `floor` rejects a debit larger than unused credit + advance (402 INSUFFICIENT_CREDIT).
 */
export async function applyEntry({
  userId,
  tenantId,
  type,
  kind = "adjustment",
  amount,
  amountPaise,
  note = "",
  reference = "",
  orderId = null,
  actorId = null,
  floor = false,
  session = null,
}) {
  const paise = amountPaise != null ? Math.round(amountPaise) : toPaise(amount);
  if (!Number.isInteger(paise) || paise <= 0) {
    if (paise === 0) return getOrCreateLedger(userId, tenantId, { session });
    throw new AppError(400, "Amount must be positive", "VALIDATION_ERROR");
  }
  return runInTx(session, async (s) => {
    const ledger = await getOrCreateLedger(userId, tenantId, { session: s });
    const movement = movementFor(type, kind);
    const signed = type === "debit" ? -paise : paise;
    const filter = { _id: ledger._id };
    if (type === "debit" && floor) filter.$expr = { $gte: [{ $add: [BALANCE_PAISE, ADVANCE_PAISE] }, paise] };
    const updated = await CustomerLedger.findOneAndUpdate(
      filter,
      movement === "line" ? updatePipeline("line", signed) : updatePipeline(movement, paise),
      withSession(s, { new: true })
    );
    if (!updated) {
      throw new AppError(
        402,
        `Credit limit exceeded. Available balance is ₹${fromPaise(spendablePaise(ledger)).toFixed(2)}.`,
        "INSUFFICIENT_CREDIT"
      );
    }
    const advanceDelta = (updated.advancePaise || 0) - (ledger.advancePaise || 0);
    const view = presentLedger(updated);
    const entry = {
      userId: updated.userId,
      tenantId: updated.tenantId,
      ledgerId: updated._id,
      type,
      kind,
      amountPaise: paise,
      balanceAfterPaise: updated.balancePaise,
      advanceDeltaPaise: advanceDelta,
      advanceAfterPaise: view.advancePaise,
      outstandingAfterPaise: view.outstandingPaise,
      amount: fromPaise(paise),
      balanceAfter: fromPaise(updated.balancePaise),
      note,
      reference,
      orderId: orderId || null,
      actorId: actorId || null,
    };
    if (kind === "payment" && paymentReferenceKey(reference)) entry.referenceKey = paymentReferenceKey(reference);
    const [created] = await LedgerEntry.create([entry], withSession(s));
    updated.$locals = { ...(updated.$locals || {}), entry: created, advanceDeltaPaise: advanceDelta };
    return updated;
  });
}

/**
 * Enable credit + PO terms for a buyer with a store and grant the opening credit exactly once
 * (conditional on openingGrantedAt + unique opening entry). Used by seeding and by sellers.
 */
export async function ensureOpeningBalance(userId, tenantId, amount = 0, { session = null, actorId = null } = {}) {
  const paise = toPaise(amount);
  return runInTx(session, async (s) => {
    const ledger = await getOrCreateLedger(userId, tenantId, { session: s });
    const claimed = await CustomerLedger.findOneAndUpdate(
      { _id: ledger._id, openingGrantedAt: null },
      {
        $set: {
          openingGrantedAt: new Date(),
          creditLimitPaise: paise,
          "buyerTerms.creditEnabled": true,
          "buyerTerms.purchaseOrderEnabled": true,
          "buyerTerms.updatedAt": new Date(),
        },
      },
      withSession(s, { new: true })
    );
    if (!claimed || paise <= 0) return claimed || ledger;
    return applyEntry({ userId, tenantId, type: "credit", kind: "opening", amountPaise: paise, note: "Opening credit limit", actorId, session: s });
  });
}

/** Throws unless this store has enabled the method for this buyer. */
export async function assertTermsAllowed({ userId, tenantId, paymentMethod, session = null }) {
  if (!LEDGER_PAYMENT_METHODS.includes(paymentMethod)) return null;
  const ledger = await findLedger(userId, tenantId, session);
  const terms = ledger?.buyerTerms || {};
  const ok = paymentMethod === "credit_terms" ? terms.creditEnabled : terms.purchaseOrderEnabled;
  if (!ok) {
    throw new AppError(
      403,
      paymentMethod === "credit_terms"
        ? "This store has not enabled credit terms for your account"
        : "This store has not enabled purchase orders for your account",
      "TERMS_NOT_ENABLED"
    );
  }
  return ledger;
}

/** Debit an order placed on credit / PO. Must run inside the checkout transaction; failure aborts checkout. */
export async function debitOrder(order, { session = null } = {}) {
  if (!order?.buyerId || !order.total) return null;
  if (!LEDGER_PAYMENT_METHODS.includes(order.paymentMethod)) return null;
  return runInTx(session, async (s) => {
    await assertTermsAllowed({ userId: order.buyerId, tenantId: order.tenantId, paymentMethod: order.paymentMethod, session: s });
    const ledger = await applyEntry({
      userId: order.buyerId,
      tenantId: order.tenantId,
      type: "debit",
      kind: "order",
      amount: order.total,
      note: `Order ${order.orderNumber}`,
      orderId: order._id,
      floor: true,
      session: s,
    });
    await Order.updateOne({ _id: order._id }, { $set: { ledgerDebit: order.total } }, withSession(s));
    order.ledgerDebit = order.total;
    return ledger;
  });
}

/** Reverse an order's debit once (conditional on ledgerDebit > 0). */
export async function creditOrder(order, note, { session = null, actorId = null } = {}) {
  if (!order?.buyerId) return null;
  return runInTx(session, async (s) => {
    const prior = await Order.findOneAndUpdate(
      { _id: order._id, ledgerDebit: { $gt: 0 } },
      { $set: { ledgerDebit: 0 } },
      withSession(s, { new: false })
    );
    if (!prior) return null;
    order.ledgerDebit = 0;
    return applyEntry({
      userId: prior.buyerId,
      tenantId: prior.tenantId,
      type: "credit",
      kind: "reversal",
      amount: prior.ledgerDebit,
      note: note || `Reversal ${prior.orderNumber}`,
      orderId: prior._id,
      actorId,
      session: s,
    });
  });
}

/**
 * Derived figures (paise). `balancePaise` above the limit (legacy data before the advance field
 * existed) is reported as advance, never as extra available credit.
 */
export function ledgerFigures(ledger) {
  const balance = ledger?.balancePaise ?? toPaise(ledger?.balance);
  const limit = Math.max(0, ledger?.creditLimitPaise || 0);
  const advance = Math.max(0, ledger?.advancePaise || 0) + Math.max(0, balance - limit);
  const available = Math.max(0, Math.min(balance, limit));
  const outstanding = Math.max(0, limit - balance);
  return { balance, limit, advance, available, outstanding };
}

/** What a buyer can spend on credit / PO right now: unused credit + advance. */
export function spendablePaise(ledger) {
  const f = ledgerFigures(ledger);
  return f.available + f.advance;
}

/**
 * Public account shape (every ledger response uses it):
 *   creditLimit   the credit line the store granted
 *   outstanding   dues the buyer owes the store (creditLimit - balance, >= 0)
 *   available     unused credit (0..creditLimit)
 *   advance       money received beyond the dues (held for the buyer; used first by new orders)
 *   spendable     available + advance
 *   balance       raw credit-line balance (legacy field; equals available unless the limit was cut below the dues)
 * Every amount is also given in paise (`*Paise`).
 */
export function presentLedger(ledger) {
  if (!ledger) return null;
  const f = ledgerFigures(ledger);
  return {
    _id: ledger._id,
    userId: ledger.userId,
    tenantId: ledger.tenantId,
    creditLimit: fromPaise(f.limit),
    creditLimitPaise: f.limit,
    outstanding: fromPaise(f.outstanding),
    outstandingPaise: f.outstanding,
    available: fromPaise(f.available),
    availablePaise: f.available,
    advance: fromPaise(f.advance),
    advancePaise: f.advance,
    spendable: fromPaise(f.available + f.advance),
    spendablePaise: f.available + f.advance,
    balance: fromPaise(f.balance),
    balancePaise: f.balance,
    buyerTerms: ledger.buyerTerms || {},
    updatedAt: ledger.updatedAt,
  };
}

const SUM_KEYS = ["creditLimitPaise", "outstandingPaise", "availablePaise", "advancePaise", "spendablePaise", "balancePaise"];

function sumAccounts(accounts) {
  const out = {};
  for (const key of SUM_KEYS) {
    const paise = accounts.reduce((sum, a) => sum + (a?.[key] || 0), 0);
    out[key] = paise;
    out[key.replace(/Paise$/, "")] = fromPaise(paise);
  }
  return out;
}

/** Buyer view (read-only: never creates an account). Totals across stores + one row per store. */
/**
 * The buyer's ledgers plus a page of entries, newest first. `page`/`limit` (≤ 100, default 1/20)
 * or a `before` cursor (an entry id or an ISO date: entries strictly older; `page` is then
 * ignored). `entriesMeta = { total, page, limit, pages, hasMore, nextBefore }`; `nextBefore` is
 * the last entry's id, to pass as `before` for the next page.
 */
export async function getLedgerForUser(userId, tenantId = null, { page: rawPage, limit: rawLimit, before } = {}) {
  const filter = { userId: oid(userId) };
  if (tenantId) filter.tenantId = oid(tenantId);
  const ledgers = await CustomerLedger.find(filter).populate("tenantId", "name slug").lean();
  const entryFilter = { userId: oid(userId) };
  if (tenantId) entryFilter.tenantId = oid(tenantId);
  const limit = Math.min(100, Math.max(1, Number(rawLimit) || 20));
  let page = Math.max(1, Number(rawPage) || 1);
  const total = await LedgerEntry.countDocuments(entryFilter);
  let pageFilter = entryFilter;
  if (before) {
    page = null;
    const key = String(before);
    if (/^[a-f\d]{24}$/i.test(key)) {
      const anchor = await LedgerEntry.findOne({ _id: key, ...entryFilter }).select("createdAt").lean();
      if (!anchor) throw new AppError(400, "Unknown before cursor", "VALIDATION_ERROR");
      pageFilter = {
        ...entryFilter,
        $or: [{ createdAt: { $lt: anchor.createdAt } }, { createdAt: anchor.createdAt, _id: { $lt: anchor._id } }],
      };
    } else {
      const at = new Date(key);
      if (Number.isNaN(at.getTime())) throw new AppError(400, "before must be an entry id or an ISO date", "VALIDATION_ERROR");
      pageFilter = { ...entryFilter, createdAt: { $lt: at } };
    }
  }
  const rows = await LedgerEntry.find(pageFilter)
    .sort({ createdAt: -1, _id: -1 })
    .skip(page ? (page - 1) * limit : 0)
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const entries = rows.slice(0, limit);
  const entriesMeta = {
    total,
    page,
    limit,
    pages: Math.ceil(total / limit) || 0,
    hasMore,
    nextBefore: hasMore ? entries[entries.length - 1]._id : null,
  };
  const accounts = ledgers.map(presentLedger);
  const updatedAt = ledgers.reduce((max, l) => (!max || l.updatedAt > max ? l.updatedAt : max), null);
  // Per-store enablement, flat, so checkout can decide which methods to offer per store group.
  const stores = ledgers.map((l, i) => {
    const a = accounts[i];
    const terms = l.buyerTerms || {};
    const tenant = l.tenantId && typeof l.tenantId === "object" ? l.tenantId : null;
    return {
      tenantId: tenant?._id || l.tenantId,
      store: tenant ? { id: tenant._id, name: tenant.name, slug: tenant.slug } : null,
      creditEnabled: Boolean(terms.creditEnabled),
      purchaseOrderEnabled: Boolean(terms.purchaseOrderEnabled),
      paymentDays: terms.paymentDays ?? null,
      creditLimit: a.creditLimit,
      spendable: a.spendable,
      spendablePaise: a.spendablePaise,
      outstanding: a.outstanding,
      available: a.available,
      advance: a.advance,
      methods: [
        ...(terms.creditEnabled ? ["credit_terms"] : []),
        ...(terms.purchaseOrderEnabled ? ["purchase_order"] : []),
      ],
    };
  });
  return {
    ...sumAccounts(accounts),
    updatedAt,
    entries,
    entriesMeta,
    ledgers: accounts.map((a, i) => ({ ...stores[i], ...a })),
    stores,
  };
}

/** All of a buyer's store accounts (one per store that gave them terms). Read-only. */
export async function getBuyerLedgers(userId) {
  const rows = await CustomerLedger.find({ userId: oid(userId) }).populate("tenantId", "name slug").lean();
  return rows.map(presentLedger);
}

/** One buyer's account with one store, or null (read-only). */
export async function getAccountSummary(userId, tenantId) {
  const ledger = await CustomerLedger.findOne({ userId: oid(userId), tenantId: oid(tenantId) }).lean();
  return presentLedger(ledger);
}

/* ------------------------------------------------------------ seller side */

/**
 * The target must be a marketplace buyer (system buyer role) with a relationship to this store:
 * an order with it, storefront affinity (homeTenantId) or an existing account (same rule as
 * reports.customerDetail). Anything else is a 404 so ids of unrelated users aren't probed.
 * Granting terms (`requireRelationship: false`) is how a store onboards a new buyer for credit before
 * their first order, so it only needs the buyer role; the account it creates is the relationship.
 */
async function assertBuyer(userId, tenantId, { requireRelationship = true } = {}) {
  const uid = oid(userId);
  const tid = oid(tenantId);
  if (!uid || !tid) throw new AppError(404, "Buyer not found", "NOT_FOUND");
  const [user, buyerRole] = await Promise.all([
    User.findById(uid).select("_id name email roleId homeTenantId").lean(),
    Role.findOne({ slug: SYSTEM_ROLES.BUYER, isSystem: true }).select("_id").lean(),
  ]);
  if (!user || !buyerRole || String(user.roleId || "") !== String(buyerRole._id)) {
    throw new AppError(404, "Buyer not found", "NOT_FOUND");
  }
  if (!requireRelationship) return { _id: user._id, name: user.name, email: user.email };
  const related =
    String(user.homeTenantId || "") === String(tid) ||
    (await Order.exists({ tenantId: tid, buyerId: uid })) ||
    (await CustomerLedger.exists({ tenantId: tid, userId: uid }));
  if (!related) throw new AppError(404, "Buyer not found", "NOT_FOUND");
  return { _id: user._id, name: user.name, email: user.email };
}

export async function listAccounts(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = { tenantId: req.tenantId };
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const users = await User.find({ $or: [{ email: rx }, { name: rx }] }).select("_id").limit(100);
    filter.userId = { $in: users.map((u) => u._id) };
  }
  const [data, total] = await Promise.all([
    CustomerLedger.find(filter).populate("userId", "name email phone").sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    CustomerLedger.countDocuments(filter),
  ]);
  return paginated(
    data.map((row) => ({ ...presentLedger(row), buyer: row.userId })),
    total,
    { page, limit }
  );
}

export async function getAccount(req, userId) {
  const buyer = await assertBuyer(userId, req.tenantId);
  const ledger = await findLedger(userId, req.tenantId);
  if (!ledger) throw new AppError(404, "No ledger for this buyer", "NOT_FOUND");
  return { ...presentLedger(ledger), buyer };
}

/** Enable/disable credit and PO for a buyer and set the credit limit (balance moves by the limit change). */
export async function setBuyerTerms(req, userId, { creditEnabled, purchaseOrderEnabled, creditLimit, paymentDays } = {}) {
  await assertBuyer(userId, req.tenantId, { requireRelationship: false });
  const tenantId = req.tenantId;
  const ledger = await withTransaction(async (session) => {
    const current = await getOrCreateLedger(userId, tenantId, { session });
    const set = { "buyerTerms.updatedBy": req.user?._id || null, "buyerTerms.updatedAt": new Date() };
    if (creditEnabled !== undefined) set["buyerTerms.creditEnabled"] = Boolean(creditEnabled);
    if (purchaseOrderEnabled !== undefined) set["buyerTerms.purchaseOrderEnabled"] = Boolean(purchaseOrderEnabled);
    if (paymentDays !== undefined) set["buyerTerms.paymentDays"] = Number(paymentDays);
    let delta = 0;
    if (creditLimit !== undefined) {
      const nextLimit = toPaise(creditLimit);
      delta = nextLimit - (current.creditLimitPaise || 0);
      set.creditLimitPaise = nextLimit;
      if (!current.openingGrantedAt) set.openingGrantedAt = new Date();
    }
    await CustomerLedger.updateOne({ _id: current._id }, { $set: set }, { session });
    if (delta !== 0) {
      // Dues are unchanged by a limit change: the balance moves with the limit.
      await applyEntry({
        userId,
        tenantId,
        type: delta > 0 ? "credit" : "debit",
        kind: "limit",
        amountPaise: Math.abs(delta),
        note: `Credit limit set to ₹${fromPaise(set.creditLimitPaise).toFixed(2)}`,
        actorId: req.user?._id,
        session,
      });
    }
    return CustomerLedger.findById(current._id).session(session);
  });
  return presentLedger(ledger);
}

function duplicatePayment(reference) {
  return new AppError(409, `Payment reference "${reference}" is already recorded for this buyer`, "DUPLICATE_PAYMENT");
}

/**
 * Payment received from the buyer. It pays the outstanding dues first; anything beyond what is
 * owed becomes advance (shown separately, used first by later orders). A reference can be
 * recorded only once per account (409 DUPLICATE_PAYMENT).
 * Returns the account plus `payment: { amount, appliedToDues, toAdvance, reference, entryId }`.
 */
export async function recordPayment(req, userId, { amount, reference = "", note = "" } = {}) {
  await assertBuyer(userId, req.tenantId);
  const existing = await findLedger(userId, req.tenantId);
  if (!existing) throw new AppError(404, "No ledger for this buyer", "NOT_FOUND");
  const ref = String(reference || "").trim();
  const key = paymentReferenceKey(ref);
  if (key && (await LedgerEntry.exists({ ledgerId: existing._id, kind: "payment", referenceKey: key }))) {
    throw duplicatePayment(ref);
  }
  let ledger;
  try {
    ledger = await applyEntry({
      userId,
      tenantId: req.tenantId,
      type: "credit",
      kind: "payment",
      amount,
      reference: ref,
      note: note || `Payment received${ref ? ` (${ref})` : ""}`,
      actorId: req.user?._id,
    });
  } catch (err) {
    if (err?.code === 11000 || /E11000/.test(String(err?.message || ""))) throw duplicatePayment(ref);
    throw err;
  }
  const paise = toPaise(amount);
  const toAdvance = Math.max(0, ledger.$locals?.advanceDeltaPaise || 0);
  return {
    ...presentLedger(ledger),
    payment: {
      amount: fromPaise(paise),
      appliedToDues: fromPaise(paise - toAdvance),
      toAdvance: fromPaise(toAdvance),
      reference: ref,
      entryId: ledger.$locals?.entry?._id || null,
    },
  };
}

/**
 * Signed manual adjustment. Positive: credits the buyer (settles dues, overflow to advance).
 * Negative: charges the buyer (advance first, then the credit line; cannot exceed spendable).
 */
export async function adjustBalance(req, userId, { amount, note } = {}) {
  await assertBuyer(userId, req.tenantId);
  const existing = await findLedger(userId, req.tenantId);
  if (!existing) throw new AppError(404, "No ledger for this buyer", "NOT_FOUND");
  const value = Number(amount);
  if (!value) throw new AppError(400, "Amount must not be 0", "VALIDATION_ERROR");
  const ledger = await applyEntry({
    userId,
    tenantId: req.tenantId,
    type: value > 0 ? "credit" : "debit",
    kind: "adjustment",
    amount: Math.abs(value),
    note,
    floor: value < 0,
    actorId: req.user?._id,
  });
  return presentLedger(ledger);
}

/** Statement: opening balance at `from`, entries in range (paginated), closing balance. */
export async function getStatement(req, userId) {
  const buyer = await assertBuyer(userId, req.tenantId);
  const tenantId = req.tenantId;
  const ledger = await findLedger(userId, tenantId);
  if (!ledger) throw new AppError(404, "No ledger for this buyer", "NOT_FOUND");
  const { page, limit, skip } = paginate(req.query);
  // "YYYY-MM-DD" = IST calendar day (`to` inclusive of the whole day); ISO timestamps as given.
  const from = parseBound(req.query.from);
  const to = parseBound(req.query.to, true);
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  const filter = { ledgerId: ledger._id };
  const legacyFilter = { userId: oid(userId), tenantId: oid(tenantId) };
  const base = { $or: [filter, { ...legacyFilter, ledgerId: null }] };
  const inRange = Object.keys(range).length ? { ...base, createdAt: range } : base;
  const [entries, total, before] = await Promise.all([
    LedgerEntry.find(inRange).sort({ createdAt: 1 }).skip(skip).limit(limit).lean(),
    LedgerEntry.countDocuments(inRange),
    range.$gte
      ? LedgerEntry.findOne({ ...base, createdAt: { $lt: range.$gte } }).sort({ createdAt: -1 }).lean()
      : null,
  ]);
  // Closing figures: the account itself unless the range ends in the past.
  const last = range.$lte ? await LedgerEntry.findOne(inRange).sort({ createdAt: -1 }).lean() : null;
  const account = presentLedger(ledger);
  return {
    account: { ...account, buyer },
    openingBalance: before ? fromPaise(before.balanceAfterPaise ?? toPaise(before.balanceAfter)) : 0,
    openingOutstanding: before ? fromPaise(before.outstandingAfterPaise || 0) : 0,
    openingAdvance: before ? fromPaise(before.advanceAfterPaise || 0) : 0,
    closingBalance: last ? fromPaise(last.balanceAfterPaise ?? toPaise(last.balanceAfter)) : account.balance,
    closingOutstanding: last ? fromPaise(last.outstandingAfterPaise || 0) : account.outstanding,
    closingAdvance: last ? fromPaise(last.advanceAfterPaise || 0) : account.advance,
    ...paginated(entries, total, { page, limit }),
  };
}
