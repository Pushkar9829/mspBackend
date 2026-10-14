import mongoose from "mongoose";
import { User } from "../modules/users/user.model.js";

/** Id string of a user reference (ObjectId, populated object or string), else "". */
function refId(value) {
  if (!value) return "";
  if (typeof value === "object" && value._id) return String(value._id);
  return mongoose.isValidObjectId(String(value)) ? String(value) : "";
}

/**
 * One query: Map(userId -> { id, name, email }) for every id given (unknown / deleted users are
 * absent from the map). Admin-facing "who did this" labels.
 */
export async function loadUserRefs(ids) {
  const unique = [...new Set((ids || []).map(refId).filter(Boolean))];
  if (!unique.length) return new Map();
  const users = await User.find({ _id: { $in: unique } }).select("name email").lean();
  return new Map(users.map((u) => [String(u._id), { id: u._id, name: u.name || "", email: u.email || "" }]));
}

/** `by` (id) -> { id, name, email } using a map from loadUserRefs (unknown id -> { id, name: "", email: "" }; null stays null). */
export function userRef(value, map) {
  const id = refId(value);
  if (!id) return null;
  return map.get(id) || { id, name: "", email: "" };
}
