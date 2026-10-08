import mongoose from "mongoose";
import { Address, MAX_ADDRESSES_PER_USER } from "./address.model.js";
import { AppError } from "../../utils/AppError.js";
import { geocodeAddress } from "./service.js";
import { normalizeIndianState } from "./pincode.js";

/** `state` → full name + `stateCode` (accepts "DL", "Delhi", "New Delhi", …). */
function withState(body) {
  if (body.state === undefined) return body;
  const { stateCode, state } = normalizeIndianState(body.state);
  return { ...body, state, stateCode };
}

export async function listAddresses(userId) {
  return Address.find({ userId }).sort({ isDefault: -1, createdAt: -1 }).limit(MAX_ADDRESSES_PER_USER);
}

/**
 * Make `addressId` the user's only default. Runs in a transaction (write conflicts between
 * concurrent "set default" calls are retried by the driver); the partial unique index
 * `one_default_per_user` guarantees there can never be two defaults even without transactions.
 */
async function makeDefault(userId, addressId) {
  const apply = (session) =>
    Address.updateMany({ userId, isDefault: true, _id: { $ne: addressId } }, { $set: { isDefault: false } }, { session }).then(() =>
      Address.findOneAndUpdate({ _id: addressId, userId }, { $set: { isDefault: true } }, { new: true, session })
    );
  let session;
  try {
    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      result = await apply(session);
    });
    return result;
  } catch (err) {
    // Standalone MongoDB (no transactions): fall back to retrying on the unique index.
    const noTxn = err?.code === 20 || /Transaction numbers are only allowed|replica set/i.test(err?.message || "");
    if (!noTxn) throw err;
  } finally {
    await session?.endSession();
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await apply(undefined);
    } catch (err) {
      if (err?.code !== 11000) throw err;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (attempt + 1)));
    }
  }
  throw new AppError(409, "Could not set default address, please retry", "CONFLICT");
}

async function withGeo(body) {
  if (body.latitude != null && body.longitude != null) return { ...body, geoApproximate: false };
  const geo = await geocodeAddress(body);
  return {
    ...body,
    latitude: geo.latitude,
    longitude: geo.longitude,
    placeId: body.placeId || geo.placeId || "",
    geoApproximate: Boolean(geo.approximate),
  };
}

export async function createAddress(userId, body) {
  const count = await Address.countDocuments({ userId });
  if (count >= MAX_ADDRESSES_PER_USER) {
    throw new AppError(400, `At most ${MAX_ADDRESSES_PER_USER} addresses`, "LIMIT_REACHED");
  }
  const { isDefault, ...fields } = await withGeo(withState(body));
  const addr = await Address.create({ ...fields, userId, isDefault: false });
  const hasDefault = await Address.exists({ userId, isDefault: true });
  if (isDefault || !hasDefault) return makeDefault(userId, addr._id);
  return addr;
}

const GEO_FIELDS = ["addressLine1", "city", "state", "postalCode"];

export async function updateAddress(userId, id, body) {
  const addr = await Address.findOne({ _id: id, userId });
  if (!addr) throw new AppError(404, "Address not found", "NOT_FOUND");
  const { isDefault, ...fields } = withState(body);
  let patch = fields;
  const moved = GEO_FIELDS.some((f) => fields[f] !== undefined && fields[f] !== addr[f]);
  if (moved && (fields.latitude == null || fields.longitude == null)) {
    patch = await withGeo({ ...addr.toObject(), ...fields, latitude: null, longitude: null });
    patch = Object.fromEntries(
      Object.entries(patch).filter(([k]) => k in fields || ["latitude", "longitude", "placeId", "geoApproximate"].includes(k))
    );
  } else if (fields.latitude != null && fields.longitude != null) {
    patch = { ...fields, geoApproximate: false };
  }
  let updated = addr;
  if (Object.keys(patch).length) {
    updated = await Address.findOneAndUpdate({ _id: id, userId }, { $set: patch }, { new: true, runValidators: true });
  }
  if (isDefault === true) return makeDefault(userId, addr._id);
  if (isDefault === false && addr.isDefault) {
    updated = await Address.findOneAndUpdate({ _id: id, userId }, { $set: { isDefault: false } }, { new: true });
  }
  return updated;
}

export async function deleteAddress(userId, id) {
  const addr = await Address.findOneAndDelete({ _id: id, userId });
  if (!addr) throw new AppError(404, "Address not found", "NOT_FOUND");
  if (addr.isDefault) {
    const next = await Address.findOne({ userId }).sort({ createdAt: -1 }).select("_id");
    if (next) await makeDefault(userId, next._id);
  }
  return { ok: true, id };
}

export async function getAddressForUser(userId, id) {
  const addr = await Address.findOne({ _id: id, userId });
  if (!addr) throw new AppError(404, "Address not found", "NOT_FOUND");
  return addr;
}

/**
 * Idempotent migration: addresses without `stateCode` get `state` normalised to the full name
 * and `stateCode` set (null when the state is not recognised, so they are not revisited).
 * Returns the number of addresses updated.
 */
export async function normalizeAddressStates({ max = 100000 } = {}) {
  let updated = 0;
  const cursor = Address.find({ stateCode: { $exists: false } }).select("_id state").limit(max).lean().cursor();
  let ops = [];
  const flush = async () => {
    if (ops.length) await Address.collection.bulkWrite(ops, { ordered: false });
    updated += ops.length;
    ops = [];
  };
  for await (const row of cursor) {
    const { state, stateCode } = normalizeIndianState(row.state);
    ops.push({ updateOne: { filter: { _id: row._id, stateCode: { $exists: false } }, update: { $set: { state: state || row.state, stateCode } } } });
    if (ops.length >= 500) await flush();
  }
  await flush();
  return updated;
}

/**
 * Migration: keep only the newest default per user, then build the partial unique index.
 * Idempotent; called at startup.
 */
export async function ensureAddressIndexes() {
  const dupes = await Address.aggregate([
    { $match: { isDefault: true } },
    { $sort: { updatedAt: -1 } },
    { $group: { _id: "$userId", ids: { $push: "$_id" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  for (const d of dupes) {
    await Address.updateMany({ _id: { $in: d.ids.slice(1) } }, { $set: { isDefault: false } });
  }
  await Address.collection.updateMany({ $or: [{ tenantId: { $exists: true } }, { serviceability: { $exists: true } }] }, { $unset: { tenantId: "", serviceability: "" } });
  await Address.createIndexes();
  return { fixedUsers: dupes.length };
}
