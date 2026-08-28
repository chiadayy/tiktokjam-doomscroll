import path from "node:path";
import { AgentService } from "./agent-service.js";
import { startArkProxy, type ArkProxy } from "./ark-proxy.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();

// Start the provider adapter before writing config.toml, so Codex is pointed at
// it rather than at Ark directly. Without this, only the first turn of a thread
// succeeds. See ark-proxy.ts.
let arkProxy: ArkProxy | null = null;
if (config.arkProxyEnabled) {
  arkProxy = await startArkProxy(config);
}
await writeCodexConfig(config, arkProxy?.baseUrlForCodex ?? config.arkBaseUrl);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

const app = await createApp(config, service);

if (arkProxy) {
  app.log.info(
    { port: arkProxy.port, upstream: config.arkBaseUrl },
    "Ark provider adapter listening",
  );
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await arkProxy?.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
