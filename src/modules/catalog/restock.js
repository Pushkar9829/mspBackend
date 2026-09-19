import { Product } from "./product.model.js";
import { ProductVariant } from "./variant.model.js";
import { RestockAlert } from "./restockAlert.model.js";
import { AppError } from "../../utils/AppError.js";
import { persistAndPush } from "../notifications/service.js";

export async function subscribeRestock(req, slug, { email, variantId } = {}) {
  const product = await Product.findOne({ sku: String(slug || "").toUpperCase(), status: "published" });
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");

  const userId = req.user?._id || null;
  const mail = String(email || req.user?.email || "")
    .trim()
    .toLowerCase();
  if (!userId && !mail) throw new AppError(400, "Email is required", "VALIDATION_ERROR");

  const filter = userId ? { productId: product._id, userId } : { productId: product._id, email: mail };
  const doc = await RestockAlert.findOneAndUpdate(
    filter,
    {
      $set: {
        tenantId: product.tenantId,
        productId: product._id,
        variantId: variantId || null,
        userId,
        email: mail,
        notifiedAt: null,
      },
    },
    { upsert: true, new: true }
  );
  return { ok: true, subscribed: true, id: doc._id };
}

export async function notifyRestockForVariant(variantId) {
  const variant = await ProductVariant.findById(variantId).select("productId sku");
  if (!variant) return { notified: 0 };
  const product = await Product.findById(variant.productId).select("name sku tenantId");
  if (!product) return { notified: 0 };

  const alerts = await RestockAlert.find({
    productId: product._id,
    notifiedAt: null,
  }).limit(200);

  let notified = 0;
  for (const alert of alerts) {
    if (alert.userId) {
      await persistAndPush({
        userId: alert.userId,
        tenantId: product.tenantId,
        event: "RESTOCK_AVAILABLE",
        title: "Back in stock",
        body: `${product.name} is back in stock. Buy again now.`,
        data: {
          productId: product._id,
          slug: String(product.sku || "").toLowerCase(),
          variantId: variant._id,
        },
      });
    }
    alert.notifiedAt = new Date();
    await alert.save();
    notified += 1;
  }
  return { notified };
}
