import { CustomerLedger, LedgerEntry } from "./ledger.model.js";
import { AppError } from "../../utils/AppError.js";
import { round2 } from "../pricing/engine.js";

export async function getOrCreateLedger(userId, tenantId = null) {
  if (!userId) throw new AppError(400, "User required", "VALIDATION_ERROR");
  let ledger = await CustomerLedger.findOne({ userId });
  if (!ledger) {
    ledger = await CustomerLedger.create({ userId, tenantId: tenantId || null, balance: 0 });
  }
  return ledger;
}

export async function applyEntry({ userId, tenantId, type, amount, note, orderId }) {
  const value = round2(Number(amount) || 0);
  if (value <= 0) return getOrCreateLedger(userId, tenantId);
  const ledger = await getOrCreateLedger(userId, tenantId);
  const next = round2(type === "debit" ? ledger.balance - value : ledger.balance + value);
  ledger.balance = next;
  if (tenantId && !ledger.tenantId) ledger.tenantId = tenantId;
  await ledger.save();
  await LedgerEntry.create({
    userId,
    tenantId: tenantId || ledger.tenantId || null,
    type,
    amount: value,
    balanceAfter: next,
    note: note || "",
    orderId: orderId || null,
  });
  return ledger;
}

export async function getLedgerForUser(userId, tenantId = null) {
  const ledger = await getOrCreateLedger(userId, tenantId);
  const entries = await LedgerEntry.find({ userId }).sort({ createdAt: -1 }).limit(20);
  return {
    balance: ledger.balance,
    updatedAt: ledger.updatedAt,
    entries,
  };
}

export async function ensureOpeningBalance(userId, tenantId, amount = 50000) {
  const ledger = await getOrCreateLedger(userId, tenantId);
  const hasEntries = await LedgerEntry.exists({ userId });
  if (!hasEntries && ledger.balance === 0 && amount > 0) {
    return applyEntry({
      userId,
      tenantId,
      type: "credit",
      amount,
      note: "Opening ledger balance",
    });
  }
  return ledger;
}

export async function debitOrder(order) {
  if (!order?.buyerId || !order.total) return null;
  const ledger = await applyEntry({
    userId: order.buyerId,
    tenantId: order.tenantId,
    type: "debit",
    amount: order.total,
    note: `Order ${order.orderNumber}`,
    orderId: order._id,
  });
  order.ledgerDebit = order.total;
  await order.save();
  return ledger;
}

export async function creditOrder(order, note) {
  const amount = Number(order.ledgerDebit) || 0;
  if (!order?.buyerId || amount <= 0) return null;
  const ledger = await applyEntry({
    userId: order.buyerId,
    tenantId: order.tenantId,
    type: "credit",
    amount,
    note: note || `Reversal ${order.orderNumber}`,
    orderId: order._id,
  });
  order.ledgerDebit = 0;
  await order.save();
  return ledger;
}
