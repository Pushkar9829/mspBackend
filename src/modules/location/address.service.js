import { Address } from "./address.model.js";
import { AppError } from "../../utils/AppError.js";
import { geocodeStub } from "./service.js";

export async function listAddresses(userId) {
  return Address.find({ userId }).sort({ isDefault: -1, createdAt: -1 });
}

export async function createAddress(userId, body) {
  if (!body.latitude || !body.longitude) {
    const geo = await geocodeStub(body);
    body.latitude = body.latitude ?? geo.latitude;
    body.longitude = body.longitude ?? geo.longitude;
    body.placeId = body.placeId || geo.placeId;
  }
  if (body.isDefault) {
    await Address.updateMany({ userId }, { isDefault: false });
  }
  return Address.create({ ...body, userId });
}

export async function updateAddress(userId, id, body) {
  const addr = await Address.findOne({ _id: id, userId });
  if (!addr) throw new AppError(404, "Address not found", "NOT_FOUND");
  if (body.isDefault) {
    await Address.updateMany({ userId }, { isDefault: false });
  }
  Object.assign(addr, body);
  await addr.save();
  return addr;
}

export async function deleteAddress(userId, id) {
  const addr = await Address.findOneAndDelete({ _id: id, userId });
  if (!addr) throw new AppError(404, "Address not found", "NOT_FOUND");
  return { ok: true, id };
}

export async function getAddressForUser(userId, id) {
  const addr = await Address.findOne({ _id: id, userId });
  if (!addr) throw new AppError(404, "Address not found", "NOT_FOUND");
  return addr;
}
