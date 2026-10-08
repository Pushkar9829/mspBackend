import mongoose from "mongoose";
import { Tenant } from "./tenant.model.js";
import { Settings } from "../settings/settings.model.js";

/**
 * Buyer-facing store card: { id, name, displayName, slug, city, logo }.
 * `displayName` = the store's `store.displayName` setting, else its name.
 */
export function toStoreCard(tenant, displayName = "") {
  if (!tenant) return null;
  return {
    id: tenant._id,
    name: tenant.name,
    displayName: String(displayName || "").trim() || tenant.name,
    slug: tenant.slug,
    city: tenant.pickupAddress?.city || "",
    logo: tenant.branding?.logo || "",
  };
}

/** Store cards for many tenants in two queries. Map(String(tenantId) -> card). Unknown ids are absent. */
export async function storeCards(tenantIds = []) {
  const ids = [...new Set(tenantIds.filter(Boolean).map(String))]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  const map = new Map();
  if (!ids.length) return map;
  const [tenants, names] = await Promise.all([
    Tenant.find({ _id: { $in: ids } }).select("name slug pickupAddress.city branding.logo").lean(),
    Settings.find({ scope: "tenant", tenantId: { $in: ids }, key: "store.displayName" }).select("tenantId value").lean(),
  ]);
  const nameById = new Map(names.map((row) => [String(row.tenantId), row.value]));
  for (const tenant of tenants) map.set(String(tenant._id), toStoreCard(tenant, nameById.get(String(tenant._id))));
  return map;
}
