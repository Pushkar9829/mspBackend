import mongoose from "mongoose";
import { env } from "./env.js";

let connecting;

export async function connectDb() {
  mongoose.set("strictQuery", true);
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!connecting) {
    connecting = mongoose
      .connect(env.mongoUri)
      .then(() => {
        console.log("Connected to MongoDB");
        return mongoose.connection;
      })
      .catch((err) => {
        connecting = undefined;
        throw err;
      });
  }
  return connecting;
}

export function isReplicaSet() {
  try {
    return Boolean(mongoose.connection.client?.options?.replicaSet);
  } catch {
    return false;
  }
}
