import { Tenant } from "../tenants/tenant.model.js";
import { Warehouse } from "../inventory/warehouse.model.js";
import { AppError } from "../../utils/AppError.js";
import { env } from "../../config/env.js";

/** Google geocoding runs only when the platform setting `platform.mapsProvider` is "google" and MAPS_API_KEY is set. */
async function useGoogle() {
  if (!env.mapsApiKey) return false;
  try {
    const { mapsProvider } = await import("../settings/service.js");
    return (await mapsProvider(env.mapsProvider || "google")) === "google";
  } catch {
    return true;
  }
}

export async function geocodeAddress({ postalCode, city, state, addressLine1 }) {
  const formatted = [addressLine1, city, state, postalCode].filter(Boolean).join(", ");
  if (await useGoogle()) {
    try {
      const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      url.searchParams.set("address", formatted || String(postalCode || city || ""));
      url.searchParams.set("key", env.mapsApiKey);
      const res = await fetch(url);
      const data = await res.json();
      const hit = data.results?.[0];
      if (hit?.geometry?.location) {
        return {
          latitude: hit.geometry.location.lat,
          longitude: hit.geometry.location.lng,
          placeId: hit.place_id || "",
          provider: "google",
          approximate: false,
          formatted: hit.formatted_address || formatted,
        };
      }
    } catch {
      /* fall through to a local pin */
    }
  }
  return geocodeStub({ postalCode, city, addressLine1: formatted || addressLine1 });
}

/**
 * Offline placeholder geocoder used when MAPS_API_KEY is not set (or the provider failed).
 * The coordinates are a deterministic pseudo-location derived from the PIN code — NOT a real
 * position — so results are flagged `approximate: true` and radius-based serviceability must
 * not rely on them.
 */
export async function geocodeStub({ postalCode, city, addressLine1 }) {
  if (!addressLine1 && !postalCode && !city) {
    return { latitude: null, longitude: null, placeId: "", provider: "stub", approximate: true };
  }
  const seed = Number(String(postalCode || "0").replace(/\D/g, "").slice(0, 6)) || 0;
  return {
    latitude: 20 + (seed % 1500) / 100,
    longitude: 70 + (seed % 1200) / 100,
    placeId: `stub-${postalCode || city || "na"}`,
    provider: "stub",
    approximate: true,
    formatted: [addressLine1, city, postalCode].filter(Boolean).join(", "),
  };
}

function haversineKm(a, b) {
  if (a.latitude == null || b.latitude == null) return Infinity;
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Pick the delivery zone of `zones` serving a location (pure; see checkServiceability). */
export function matchZone(zones, { postalCode, latitude, longitude, approximate = false }) {
  if (!zones?.length) {
    return {
      serviceable: true,
      zone: { name: "default", etaDaysMin: 3, etaDaysMax: 7, deliveryFee: 0 },
    };
  }

  const pinMatch = zones.find((z) => z.pincodes?.includes(String(postalCode)));
  if (pinMatch) {
    return { serviceable: true, zone: pinMatch };
  }

  const hasCoords = latitude != null && longitude != null && !approximate;
  const loc = { latitude, longitude };
  for (const z of hasCoords ? zones : []) {
    if (z.radiusKm && z.center?.latitude != null) {
      const km = haversineKm(loc, z.center);
      if (km <= z.radiusKm) return { serviceable: true, zone: z };
    }
  }

  const open = zones.find((z) => !z.pincodes?.length && !z.radiusKm);
  if (open) return { serviceable: true, zone: open };

  return { serviceable: false, zone: null };
}

/**
 * `approximate: true` (coordinates from the stub geocoder) disables radius zones — only PIN-code
 * zones and open zones can match, since stub coordinates are not real positions.
 */
export async function checkServiceability({ tenantId, postalCode, latitude, longitude, approximate = false }) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw new AppError(404, "Tenant not found", "NOT_FOUND");
  return matchZone(tenant.deliveryZones || [], { postalCode, latitude, longitude, approximate });
}

const SERVICEABLE_TTL_MS = 60 * 1000;
const SERVICEABLE_MAX = 500;
const serviceableCache = new Map(); // key -> { at, ids }

/**
 * Which of `tenantIds` deliver to this location. One batched query (deliveryZones only) evaluated
 * in memory, cached briefly per PIN/coordinates/store set. Unknown tenants are not serviceable.
 */
export async function serviceableTenantIds(tenantIds, { postalCode, latitude, longitude, approximate = false } = {}) {
  const ids = (tenantIds || []).map(String);
  if (!ids.length) return [];
  const key = [postalCode, latitude ?? "", longitude ?? "", approximate ? 1 : 0, [...ids].sort().join(",")].join("|");
  const hit = serviceableCache.get(key);
  if (hit && Date.now() - hit.at < SERVICEABLE_TTL_MS) return hit.ids;
  const tenants = await Tenant.find({ _id: { $in: ids } }).select("deliveryZones").lean();
  const zonesById = new Map(tenants.map((t) => [String(t._id), t.deliveryZones || []]));
  const ok = (tenantIds || []).filter((id) => {
    const zones = zonesById.get(String(id));
    return zones !== undefined && matchZone(zones, { postalCode, latitude, longitude, approximate }).serviceable;
  });
  serviceableCache.delete(key);
  serviceableCache.set(key, { at: Date.now(), ids: ok });
  while (serviceableCache.size > SERVICEABLE_MAX) serviceableCache.delete(serviceableCache.keys().next().value);
  return ok;
}

export async function nearestWarehouse(tenantId, coords) {
  const warehouses = await Warehouse.find({ tenantId, status: "active" });
  if (!warehouses.length) return null;
  return warehouses
    .map((w) => ({
      warehouse: w,
      km: haversineKm(coords, { latitude: w.latitude, longitude: w.longitude }),
    }))
    .sort((a, b) => a.km - b.km)[0]?.warehouse;
}

export function etaWindow(zone, leadTimeDays = 0) {
  const min = (zone?.etaDaysMin || 2) + leadTimeDays;
  const max = (zone?.etaDaysMax || 7) + leadTimeDays;
  const start = new Date();
  start.setDate(start.getDate() + min);
  const end = new Date();
  end.setDate(end.getDate() + max);
  return { etaFrom: start, etaTo: end, etaDaysMin: min, etaDaysMax: max };
}
