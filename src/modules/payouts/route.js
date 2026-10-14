import { Tenant } from "../tenants/tenant.model.js";
import { Order } from "../orders/order.model.js";
import { SellerLedgerEntry } from "./models.js";
import { payoutSettings } from "./settings.js";
import { writeEntries } from "./ledger.js";
import * as rzp from "../checkout/razorpayApi.js";
import { decryptSecret } from "../sellerApplications/crypto.js";
import { emitDomain } from "../../utils/events.js";
import { logger } from "../../utils/logger.js";
import { AppError } from "../../utils/AppError.js";

/**
 * Razorpay Route (p4-payouts): one linked account per seller, a held transfer per online seller
 * order (released when the order is final and paid out), reversals for refunds / netting, and
 * direct transfers for balances from COD / credit repayments.
 */

/** Razorpay product activation_status -> tenant.payout.status. */
export function mapActivationStatus(value) {
  const v = String(value || "").toLowerCase();
  if (v === "activated") return "activated";
  if (v === "needs_clarification") return "needs_clarification";
  if (v === "under_review") return "under_review";
  if (v === "suspended") return "suspended";
  return "created";
}

const BUSINESS_TYPES = {
  proprietorship: "proprietorship",
  partnership: "partnership",
  llp: "llp",
  private_limited: "private_limited",
  public_limited: "public_limited",
  huf: "huf",
  trust: "trust",
  society: "society",
  other: "proprietorship",
};

/** Profile category used for every seller (Razorpay business category list). */
export const ROUTE_PROFILE = { category: "ecommerce", subcategory: "ecommerce_marketplace" };

export function linkedAccountActive(tenant) {
  return Boolean(tenant?.payout?.razorpayAccountId && tenant.payout.status === "activated");
}

export async function bankAccountNumber(tenant) {
  const bank = tenant?.kyc?.bank || {};
  if (bank.accountNumberEnc) return decryptSecret(bank.accountNumberEnc);
  const m = String(bank.accountRef || "").match(/^sellerApplication:([a-f\d]{24})$/i);
  if (!m) return null;
  const { SellerApplication } = await import("../sellerApplications/sellerApplication.model.js");
  const app = await SellerApplication.findById(m[1]).select("bank").lean();
  return app?.bank?.accountNumberEnc ? decryptSecret(app.bank.accountNumberEnc) : null;
}

/** What Razorpay needs that the store does not have yet (field names for the admin UI). */
async function missingKyc(tenant) {
  const kyc = tenant.kyc || {};
  const bp = tenant.businessProfile || {};
  const reg = kyc.registeredAddress || {};
  const out = [];
  if (!bp.email) out.push("businessProfile.email");
  if (!bp.phone) out.push("businessProfile.phone");
  if (!(kyc.legalName || bp.legalName)) out.push("kyc.legalName");
  if (!kyc.pan) out.push("kyc.pan");
  if (!(reg.addressLine1 && reg.city && reg.state && reg.postalCode)) out.push("kyc.registeredAddress");
  if (!kyc.bank?.ifsc) out.push("kyc.bank.ifsc");
  if (!kyc.bank?.holderName) out.push("kyc.bank.holderName");
  return out;
}

async function setPayout(tenantId, set) {
  const $set = {};
  for (const [k, v] of Object.entries(set)) $set[`payout.${k}`] = v;
  return Tenant.findByIdAndUpdate(tenantId, { $set }, { new: true });
}

function statusEvents(tenant, before, after, extra = {}) {
  if (before === after) return;
  if (after === "activated") emitDomain("LINKED_ACCOUNT_ACTIVATED", { tenantId: tenant._id, accountId: tenant.payout?.razorpayAccountId || "", ...extra });
  if (after === "needs_clarification") {
    emitDomain("LINKED_ACCOUNT_NEEDS_CLARIFICATION", { tenantId: tenant._id, accountId: tenant.payout?.razorpayAccountId || "", requirements: extra.requirements || [] });
  }
}

/** Apply a product entity (activation_status, requirements) to the store. */
async function applyProduct(tenant, product) {
  const before = tenant.payout?.status || "not_created";
  const status = mapActivationStatus(product?.activation_status);
  const requirements = Array.isArray(product?.requirements) ? product.requirements.slice(0, 50) : [];
  const set = { status, requirements, syncedAt: new Date(), lastError: "" };
  if (status === "activated" && !tenant.payout?.activatedAt) set.activatedAt = new Date();
  const updated = await setPayout(tenant._id, set);
  statusEvents(updated, before, status, { requirements });
  return updated;
}

/**
 * Create (or continue creating) the store's Route linked account from its KYC: account ->
 * stakeholder -> Route product (tnc accepted) -> settlement bank account. Every step is stored as
 * it completes, so a retry resumes where it failed. Existing accounts are refreshed from Razorpay.
 * Errors are stored on tenant.payout.lastError (status `failed` when no account exists yet) and
 * rethrown when `throwOnError`.
 */
export async function createOrRefreshLinkedAccount(tenantId, { throwOnError = false } = {}) {
  let tenant = await Tenant.findById(tenantId);
  if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
  try {
    const p = tenant.payout || {};
    if (p.razorpayAccountId && p.productId && p.bankLinkedAt) return syncLinkedAccount(tenant);
    const missing = await missingKyc(tenant);
    const accountNumber = await bankAccountNumber(tenant);
    if (!accountNumber) missing.push("kyc.bank.accountNumber");
    if (missing.length) {
      throw new AppError(400, `Store KYC is incomplete for Razorpay Route: ${missing.join(", ")}`, "KYC_INCOMPLETE", { fields: Object.fromEntries(missing.map((m) => [m, "Required"])) });
    }
    const kyc = tenant.kyc;
    const bp = tenant.businessProfile;
    const reg = kyc.registeredAddress;
    const contact = kyc.bank.holderName || tenant.name;
    if (!p.razorpayAccountId) {
      const account = await rzp.createLinkedAccount({
        email: bp.email,
        phone: String(bp.phone).replace(/\D/g, "").slice(-10),
        type: "route",
        reference_id: String(tenant._id).slice(0, 20),
        legal_business_name: kyc.legalName || bp.legalName || tenant.name,
        business_type: BUSINESS_TYPES[kyc.businessType] || "proprietorship",
        contact_name: contact,
        profile: {
          ...ROUTE_PROFILE,
          addresses: {
            registered: {
              street1: reg.addressLine1,
              street2: reg.addressLine2 || reg.city,
              city: reg.city,
              state: String(reg.state).toUpperCase(),
              postal_code: String(reg.postalCode),
              country: "IN",
            },
          },
        },
        legal_info: { pan: kyc.pan, ...(kyc.gstin || bp.gstin ? { gst: kyc.gstin || bp.gstin } : {}) },
        notes: { tenant_id: String(tenant._id), slug: tenant.slug },
      });
      if (!account?.id) throw new AppError(502, "Razorpay did not return the linked account", "PAYMENT_PROVIDER_ERROR");
      tenant = await setPayout(tenant._id, { razorpayAccountId: account.id, status: "created", lastError: "" });
    }
    const acc = tenant.payout.razorpayAccountId;
    if (!tenant.payout.stakeholderId) {
      const sh = await rzp.createStakeholder(acc, { name: contact, email: bp.email, ...(kyc.pan ? { kyc: { pan: kyc.pan } } : {}) });
      tenant = await setPayout(tenant._id, { stakeholderId: sh?.id || "created" });
    }
    if (!tenant.payout.productId) {
      const product = await rzp.requestRouteProduct(acc, {});
      if (!product?.id) throw new AppError(502, "Razorpay did not return the Route product", "PAYMENT_PROVIDER_ERROR");
      tenant = await setPayout(tenant._id, { productId: product.id });
      tenant = await applyProduct(tenant, product);
    }
    if (!tenant.payout.bankLinkedAt) {
      const product = await rzp.updateRouteProduct(acc, tenant.payout.productId, {
        settlements: { account_number: accountNumber, ifsc_code: kyc.bank.ifsc, beneficiary_name: contact },
        tnc_accepted: true,
      });
      tenant = await setPayout(tenant._id, { bankLinkedAt: new Date() });
      tenant = await applyProduct(tenant, product);
    }
    return tenant;
  } catch (err) {
    const fresh = await Tenant.findById(tenantId);
    const set = { lastError: String(err.message || err).slice(0, 500), syncedAt: new Date() };
    if (!fresh?.payout?.razorpayAccountId) set.status = "failed";
    await setPayout(tenantId, set);
    if (throwOnError) throw err;
    logger.warn("payouts: linked account creation failed", { tenantId: String(tenantId), err: err.message });
    return Tenant.findById(tenantId);
  }
}

/** Pull the Route product status from Razorpay (job / webhook / admin refresh). */
export async function syncLinkedAccount(tenantOrId) {
  const tenant = tenantOrId?._id ? tenantOrId : await Tenant.findById(tenantOrId);
  if (!tenant?.payout?.razorpayAccountId || !tenant.payout.productId) return tenant;
  const product = await rzp.fetchRouteProduct(tenant.payout.razorpayAccountId, tenant.payout.productId);
  return applyProduct(tenant, product);
}

/** Approval hook (best effort): create the linked account when Route payouts are on. */
export async function autoCreateLinkedAccount(tenantId) {
  try {
    const settings = await payoutSettings();
    if (settings.mode !== "route" || !rzp.razorpayConfigured()) return null;
    return await createOrRefreshLinkedAccount(tenantId);
  } catch (err) {
    logger.warn("payouts: auto linked account failed", { tenantId: String(tenantId), err: err.message });
    return null;
  }
}

/* ------------------------------------------------------------------ order transfers */

async function orderNetPaise(orderId) {
  const rows = await SellerLedgerEntry.aggregate([{ $match: { orderId } }, { $group: { _id: null, total: { $sum: "$amountPaise" } } }]);
  return rows[0]?.total || 0;
}

function firstTransfer(res) {
  if (Array.isArray(res?.items)) return res.items[0] || null;
  if (Array.isArray(res)) return res[0] || null;
  return res?.id ? res : null;
}

/**
 * Online seller order on the ledger, Route mode, active linked account: transfer the order's
 * current net from its payment to the seller, on hold (released by the payout run when final).
 * Claimed with transferStatus '' -> 'pending'; a 'pending' claim older than 10 minutes is
 * resolved from Razorpay's list of the payment's transfers (notes.order_id) before retrying.
 */
export async function ensureOrderTransfer(orderId) {
  const settings = await payoutSettings();
  if (settings.mode !== "route") return null;
  let order = await Order.findById(orderId);
  if (!order || order.payout?.basis !== "online" || !order.razorpayPaymentId || order.payout?.finalAt) return null;
  const tenant = await Tenant.findById(order.tenantId);
  if (!linkedAccountActive(tenant)) return null;
  const status = order.payout?.transferStatus || "";
  if (status === "pending") {
    if (Date.now() - new Date(order.updatedAt).getTime() < 10 * 60 * 1000) return null;
    const list = await rzp.fetchPaymentTransfers(order.razorpayPaymentId).catch(() => null);
    const found = (list?.items || []).find((t) => t?.notes?.order_id === String(order._id));
    if (found) return markHeld(order, found, settings);
    await Order.updateOne({ _id: order._id, "payout.transferStatus": "pending" }, { $set: { "payout.transferStatus": "" } });
  } else if (status) {
    return null;
  }
  const net = await orderNetPaise(order._id);
  if (net <= 0) {
    await Order.updateOne({ _id: order._id, "payout.transferStatus": "" }, { $set: { "payout.transferStatus": "none" } });
    return null;
  }
  order = await Order.findOneAndUpdate({ _id: order._id, "payout.transferStatus": "" }, { $set: { "payout.transferStatus": "pending" } }, { new: true });
  if (!order) return null;
  try {
    const res = await rzp.createPaymentTransfers(order.razorpayPaymentId, [
      {
        account: tenant.payout.razorpayAccountId,
        amount: net,
        currency: "INR",
        on_hold: true,
        notes: { order_id: String(order._id), order_number: order.orderNumber, tenant_id: String(order.tenantId) },
      },
    ]);
    const transfer = firstTransfer(res);
    if (!transfer?.id) throw new Error("Razorpay did not return the transfer");
    return markHeld(order, transfer, settings);
  } catch (err) {
    await Order.updateOne(
      { _id: order._id, "payout.transferStatus": "pending" },
      { $set: { "payout.transferStatus": "", "payout.lastError": String(err.message || err).slice(0, 300) } }
    );
    throw err;
  }
}

async function markHeld(order, transfer, settings) {
  const updated = await Order.findOneAndUpdate(
    { _id: order._id },
    {
      $set: {
        "payout.transferId": transfer.id,
        "payout.transferStatus": "held",
        "payout.transferAmountPaise": Number(transfer.amount) || 0,
        "payout.reversedPaise": Number(transfer.amount_reversed) || 0,
        "payout.lastError": "",
      },
    },
    { new: true }
  );
  await SellerLedgerEntry.updateMany({ orderId: order._id, transferId: "", kind: { $in: ["sale", "platform_fee", "partner_fee", "gateway_fee", "tcs", "tds"] }, refundRef: "" }, { $set: { transferId: transfer.id } });
  const fee = Math.max(0, Math.round(Number(transfer.fees) || 0));
  if (fee > 0 && settings.passGatewayFees) {
    await writeEntries([
      {
        tenantId: order.tenantId,
        orderId: order._id,
        orderNumber: order.orderNumber,
        key: `route_fee:${order._id}`,
        kind: "route_fee",
        amountPaise: -fee,
        transferId: transfer.id,
        availableAt: updated.payout?.finalAt ? new Date() : null,
        memo: `Route transfer fee ${order.orderNumber}`,
        data: { taxPaise: Math.max(0, Math.round(Number(transfer.tax) || 0)) },
      },
    ]);
  }
  return updated;
}

/** What is still on a held transfer (paise). */
export function transferRemaining(order) {
  return Math.max(0, (order?.payout?.transferAmountPaise || 0) - (order?.payout?.reversedPaise || 0));
}

/**
 * Reverse `amountPaise` of the order's transfer exactly once per `key`. The intent is stored
 * before the call; a retry of a still-pending intent first checks the transfer's
 * amount_reversed at Razorpay so a reversal that succeeded but was not recorded is not repeated.
 */
export async function reverseOrderTransfer(orderId, key, amountPaise) {
  const amount = Math.round(amountPaise);
  if (!(amount > 0)) return null;
  const pushed = await Order.updateOne(
    { _id: orderId, "payout.transferId": { $ne: "" }, "payout.reversals.key": { $ne: key } },
    { $push: { "payout.reversals": { key, amountPaise: amount, status: "pending", at: new Date() } } }
  );
  const order = await Order.findById(orderId);
  const row = (order?.payout?.reversals || []).find((r) => r.key === key);
  if (!row || row.status === "processed") return order;
  const done = (order.payout.reversals || []).filter((r) => r.status === "processed").reduce((s, r) => s + r.amountPaise, 0);
  let reversalId = "";
  // Only a retried intent (not created by this call) may already have happened at Razorpay.
  const remote = pushed.modifiedCount ? null : await rzp.fetchTransfer(order.payout.transferId).catch(() => null);
  if (remote && Number(remote.amount_reversed) >= done + row.amountPaise) {
    reversalId = "recovered";
  } else {
    const res = await rzp.reverseTransfer(order.payout.transferId, row.amountPaise, { key: String(key).slice(0, 250), order_id: String(order._id) });
    reversalId = res?.id || "";
  }
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, "payout.reversals": { $elemMatch: { key, status: "pending" } } },
    { $set: { "payout.reversals.$.status": "processed", "payout.reversals.$.reversalId": reversalId }, $inc: { "payout.reversedPaise": row.amountPaise } },
    { new: true }
  );
  const after = updated || (await Order.findById(order._id));
  if (after && transferRemaining(after) <= 0 && after.payout.transferStatus === "held") {
    await Order.updateOne({ _id: after._id, "payout.transferStatus": "held" }, { $set: { "payout.transferStatus": "reversed" } });
  }
  return Order.findById(order._id);
}

/** Release a held transfer to the seller (PATCH on_hold=false). Idempotent. */
export async function releaseOrderTransfer(orderId, { payoutId = null } = {}) {
  const order = await Order.findById(orderId);
  if (!order?.payout?.transferId) return null;
  if (order.payout.transferStatus === "released") return order;
  if (order.payout.transferStatus !== "held") throw new AppError(409, `Transfer of ${order.orderNumber} is ${order.payout.transferStatus || "missing"}`, "INVALID_STATE");
  await rzp.updateTransfer(order.payout.transferId, { on_hold: false });
  return Order.findOneAndUpdate(
    { _id: order._id },
    { $set: { "payout.transferStatus": "released", "payout.releasedAt": new Date(), "payout.payoutId": payoutId } },
    { new: true }
  );
}

/**
 * Before a Razorpay refund (refunds.js processRefund): if the order's transfer is still held, pull
 * the refund's net seller debit back from it (partial reversal). After release nothing is reversed:
 * the debit stays on the ledger and is netted from the next payout.
 */
export async function reverseForRefund(order, refundRow) {
  if (!order?.payout?.transferId || order.payout.transferStatus !== "held" || !refundRow?.key) return null;
  const rows = await SellerLedgerEntry.find({ orderId: order._id, refundRef: refundRow.key }).select("amountPaise").lean();
  const debit = -rows.reduce((s, r) => s + r.amountPaise, 0);
  const amount = Math.min(debit, transferRemaining(order));
  if (!(amount > 0)) return null;
  return reverseOrderTransfer(order._id, `refund:${refundRow.key}`, amount);
}
