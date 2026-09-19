import mongoose from "mongoose";
import { Resolver } from "node:dns/promises";
import { env } from "./env.js";

let connecting;

async function expandSrvUri(uri) {
  if (!uri.startsWith("mongodb+srv://")) return uri;
  const parsed = new URL(uri.replace("mongodb+srv://", "https://"));
  const resolver = new Resolver();
  resolver.setServers(["8.8.8.8", "1.1.1.1"]);
  const hostname = parsed.hostname;
  const [records, txt] = await Promise.all([
    resolver.resolveSrv(`_mongodb._tcp.${hostname}`),
    resolver.resolveTxt(hostname).catch(() => []),
  ]);
  const hosts = records
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
    .map((row) => `${row.name}:${row.port}`)
    .join(",");
  const dbName = parsed.pathname.replace(/^\//, "") || "msp";
  const params = new URLSearchParams(parsed.search);
  params.set("ssl", "true");
  for (const row of txt.flat()) {
    for (const part of String(row).split("&")) {
      const [key, value] = part.split("=");
      if (key && value && !params.has(key)) params.set(key, value);
    }
  }
  const user = encodeURIComponent(decodeURIComponent(parsed.username || ""));
  const pass = encodeURIComponent(decodeURIComponent(parsed.password || ""));
  const auth = user ? `${user}:${pass}@` : "";
  return `mongodb://${auth}${hosts}/${dbName}?${params.toString()}`;
}

async function connectWithFallback(uri) {
  try {
    return await mongoose.connect(uri);
  } catch (err) {
    if (!uri.startsWith("mongodb+srv://")) throw err;
    const expanded = await expandSrvUri(uri);
    return mongoose.connect(expanded);
  }
}

export async function connectDb() {
  mongoose.set("strictQuery", true);
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!connecting) {
    connecting = connectWithFallback(env.mongoUri)
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
