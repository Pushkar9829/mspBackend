import { createServer } from "node:http";
import { app, prepareRuntime } from "../src/bootstrap.js";

export const config = {
  maxDuration: 30,
};

const server = createServer(app);

export default async function handler(req, res) {
  await prepareRuntime();
  server.emit("request", req, res);
}
