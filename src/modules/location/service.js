import { Tenant } from "../tenants/tenant.model.js";
import { Warehouse } from "../inventory/warehouse.model.js";
import { AppError } from "../../utils/AppError.js";
import { env } from "../../config/env.js";

export async function geocodeStub({ postalCode, city, addressLine1 }) {
  if (env.mapsProvider !== "stub" && env.mapsApiKey) {
    return { latitude: null, longitude: null, placeId: "", provider: env.mapsProvider };
  }
  const seed = Number(String(postalCode || "0").replace(/\D/g, "").slice(0, 6)) || 0;
  return {
    latitude: 20 + (seed % 1500) / 100,
    longitude: 70 + (seed % 1200) / 100,
    placeId: `stub-${postalCode || city || "na"}`,
    provider: "stub",
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

export async function checkServiceability({ tenantId, postalCode, latitude, longitude }) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw new AppError(404, "Tenant not found", "NOT_FOUND");
  const zones = tenant.deliveryZones || [];
  if (!zones.length) {
    return {
      serviceable: true,
      zone: { name: "default", etaDaysMin: 3, etaDaysMax: 7, deliveryFee: 0 },
    };
  }

  const pinMatch = zones.find((z) => z.pincodes?.includes(String(postalCode)));
  if (pinMatch) {
    return { serviceable: true, zone: pinMatch };
  }

  const loc = { latitude, longitude };
  for (const z of zones) {
    if (z.radiusKm && z.center?.latitude != null) {
      const km = haversineKm(loc, z.center);
      if (km <= z.radiusKm) return { serviceable: true, zone: z };
    }
  }

  const open = zones.find((z) => !z.pincodes?.length && !z.radiusKm);
  if (open) return { serviceable: true, zone: open };

  return { serviceable: false, zone: null };
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
