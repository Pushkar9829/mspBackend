import http from "http";
import { env } from "./config/env.js";
import { app, prepareRuntime } from "./bootstrap.js";
import { attachSockets } from "./sockets/index.js";
import { startJobs } from "./jobs/index.js";

async function main() {
  await prepareRuntime();

  const server = http.createServer(app);
  attachSockets(server);
  startJobs();

  server.listen(env.port, env.host, () => {
    console.log(`mspNode listening on http://${env.host}:${env.port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start mspNode:", err.message);
  process.exit(1);
});
