import { Tenant } from "../tenants/tenant.model.js";
import { Order } from "../orders/order.model.js";
import { Payout } from "./models.js";
import { writeEntries } from "./ledger.js";
import { syncLinkedAccount, mapActivationStatus } from "./route.js";
import { settleRepaymentFromWebhook } from "./repayments.js";
import { emitDomain } from "../../utils/events.js";
import { logger } from "../../utils/logger.js";

/**
 * Razorpay webhooks for seller payouts (branch of checkout/razorpay.js processRazorpayEvent):
 *  - payment.captured / order.paid for a buyer credit repayment order
 *  - transfer.* (order transfers held on Route, direct payout transfers)
 *  - reversal.*
 *  - account.* / product.route.* (linked account activation) -> status re-read from Razorpay
 *  - settlement.processed for a linked account -> remembered on the store
 * Returns true when the event was ours (handled), false to let the order logic continue.
 */
export async function handlePayoutRazorpayEvent(event) {
  const name = String(event?.event || "");
  const payload = event?.payload || {};
  if (name === "payment.captured" || name === "order.paid") {
    const payment = payload.payment?.entity;
    const orderId = payment?.order_id || payload.order?.entity?.id;
    if (!orderId) return false;
    const entity = payment || { id: "", amount: payload.order?.entity?.amount_paid };
    if (!entity.id) return false;
    return settleRepaymentFromWebhook(orderId, entity);
  }
  if (name.startsWith("transfer.")) {
    await onTransferEvent(name, payload.transfer?.entity);
    return true;
  }
  if (name.startsWith("reversal.")) {
    await onReversalEvent(name, payload.reversal?.entity);
    return true;
  }
  if (name.startsWith("account.") || name.startsWith("product.route.")) {
    await onAccountEvent(event);
    return true;
  }
  if (name.startsWith("settlement.")) {
    const accountId = event.account_id || "";
    const s = payload.settlement?.entity;
    if (accountId && s?.id) {
      await Tenant.updateOne(
        { "payout.razorpayAccountId": accountId },
        { $set: { "payout.lastSettlement": { id: s.id, amountPaise: Number(s.amount) || 0, utr: s.utr || "", status: s.status || name.split(".")[1], at: new Date() } } }
      );
    }
    return true;
  }
  return false;
}

async function onTransferEvent(name, t) {
  if (!t?.id) return;
  const failed = name === "transfer.failed" || t.status === "failed";
  const order = await Order.findOne({ "payout.transferId": t.id });
  if (order) {
    if (failed && order.payout.transferStatus !== "released") {
      // The order's money stays with the platform; its lines are paid by a direct transfer / manually.
      await Order.updateOne({ _id: order._id }, { $set: { "payout.transferStatus": "failed", "payout.lastError": t.error?.description || "Transfer failed" } });
    }
    return;
  }
  const payout = await Payout.findOne({ "transfers.transferId": t.id });
  if (!payout) return;
  const row = payout.transfers.find((r) => r.transferId === t.id);
  if (!failed) {
    if (row.status === "pending") {
      row.status = "processed";
      payout.markModified("transfers");
      await payout.save();
    }
    return;
  }
  if (row.status === "failed") return;
  row.status = "failed";
  row.error = String(t.error?.description || "Transfer failed").slice(0, 300);
  payout.markModified("transfers");
  await payout.save();
  if (payout.status === "paid") {
    // Money did not reach the seller: credit it back to the balance (paid in the next run).
    await writeEntries([
      {
        tenantId: payout.tenantId,
        key: `payout_failed:${t.id}`,
        kind: "payout",
        amountPaise: row.releasedPaise,
        availableAt: new Date(),
        memo: `Payout ${payout.number} transfer failed — amount credited back`,
        data: { transferId: t.id },
      },
    ]);
    await Payout.updateOne(
      { _id: payout._id },
      {
        $set: { status: "failed", failureReason: `Transfer ${t.id} failed: ${row.error}`, recreditedAt: new Date() },
        $push: { history: { at: new Date(), action: "transfer_failed", from: "paid", to: "failed", note: row.error } },
      }
    );
    emitDomain("PAYOUT_FAILED", { tenantId: payout.tenantId, payoutId: payout._id, number: payout.number, amountPaise: row.releasedPaise, reason: row.error, recredited: true, resource: "payout", resourceId: payout._id });
  }
}

async function onReversalEvent(name, r) {
  if (!r?.id || !r.transfer_id) return;
  const status = name === "reversal.failed" ? "failed" : "processed";
  await Order.updateOne(
    { "payout.transferId": r.transfer_id, "payout.reversals.reversalId": r.id },
    { $set: { "payout.reversals.$.status": status } }
  );
}

async function onAccountEvent(event) {
  const p = event.payload || {};
  const accountId =
    event.account_id ||
    p.account?.entity?.id ||
    p.merchant_product?.entity?.merchant_id ||
    p.merchant_product?.entity?.account_id ||
    p.product?.entity?.account_id ||
    "";
  if (!accountId) return;
  const tenant = await Tenant.findOne({ "payout.razorpayAccountId": accountId });
  if (!tenant) return;
  try {
    await syncLinkedAccount(tenant);
  } catch (err) {
    // Razorpay unreachable: fall back to the event's own status (re-checked by the sync job).
    const product = p.merchant_product?.entity || p.product?.entity || null;
    const status = product?.activation_status ? mapActivationStatus(product.activation_status) : /suspended/.test(event.event) ? "suspended" : null;
    if (status) await Tenant.updateOne({ _id: tenant._id }, { $set: { "payout.status": status, "payout.syncedAt": new Date() } });
    logger.warn("payouts: account webhook sync failed", { accountId, err: err.message });
  }
}
