// Route-level proof that the outbound redactor is actually wired in.
//
// `redact.test.ts` proves the redactor works on a string. This file proves the
// hook runs on the responses that were leaking, which is a different claim and
// the one the original defect was about: the patterns were never the problem,
// the missing hook was.
//
// The four routes below are the complete set from the exposure map — raw
// trace, run output/error, message content, and agent lastError. They are
// tested together because the point of a global hook is that it covers all of
// them at once, and the regression to catch is one of them slipping out of
// scope.

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentService } from "../../src/agent-service.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { traceFilePath } from "../../src/trace.js";

const SECRET = "sk_live_ABCDEFGHIJKLMNOP1234";
const RUN_ID = "65bde5dc-0000-4000-8000-000000000000";
const AGENT_ID = "11111111-0000-4000-8000-000000000000";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * A service that returns the secret through every carrier in the exposure map,
 * so each route has something to redact.
 */
function leakyService(): AgentService {
  return {
    systemInfo: async () => ({}),
    listAgents: () => [],
    getAgent: () => ({
      id: AGENT_ID,
      name: "leaky",
      status: "idle",
      lastError: `startup failed: STRIPE_KEY=${SECRET}`,
      reflections: [],
    }),
    getMessages: () => [
      { id: "m1", role: "agent", content: `I found STRIPE_KEY=${SECRET} in .env`, createdAt: "now" },
    ],
    getRun: () => ({
      id: RUN_ID,
      agentId: AGENT_ID,
      status: "failed",
      output: `exported STRIPE_KEY=${SECRET}`,
      error: `curl -H "Authorization: Bearer ${SECRET}" failed`,
      findings: [],
    }),
  } as unknown as AgentService;
}

async function appWithTrace(traceContents: string | null) {
  const directory = await mkdtemp(path.join(tmpdir(), "redaction-hook-"));
  const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: directory });

  if (traceContents !== null) {
    const file = traceFilePath(config.dataDirectory, RUN_ID);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, traceContents, "utf8");
  }

  const app = await createApp(config, leakyService());
  cleanups.push(async () => {
    await app.close();
  });
  return app;
}

describe("the outbound redaction hook", () => {
  it("redacts the raw trace, keeping it valid JSON Lines", async () => {
    const records = [
      { seq: 1, at: "2026-08-30T10:00:00.000Z", dir: "out", method: "session/new", payload: {} },
      {
        seq: 2,
        at: "2026-08-30T10:00:01.000Z",
        dir: "in",
        method: "codex/event",
        payload: { stdout: `STRIPE_KEY=${SECRET}` },
      },
    ];
    const ndjson = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    const app = await appWithTrace(ndjson);

    const response = await app.inject({ method: "GET", url: `/api/runs/${RUN_ID}/trace` });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SECRET);
    expect(response.headers["x-redactions"]).toBe("1");

    const lines = response.body.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(records.length);
    const parsed = lines.map((line) => JSON.parse(line) as (typeof records)[number]);
    expect(parsed.map((record) => record.seq)).toEqual([1, 2]);
    expect(parsed[1]?.method).toBe("codex/event");
  });

  it("redacts run.output and run.error", async () => {
    const app = await appWithTrace(null);

    const response = await app.inject({ method: "GET", url: `/api/runs/${RUN_ID}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SECRET);
    const body = response.json() as { run: { output: string; error: string; status: string } };
    expect(body.run.output).not.toContain(SECRET);
    expect(body.run.error).not.toContain(SECRET);
    // Redaction replaces, never deletes — the surrounding message survives.
    expect(body.run.status).toBe("failed");
    expect(body.run.output).toContain("exported");
  });

  it("redacts Message.content", async () => {
    const app = await appWithTrace(null);

    const response = await app.inject({ method: "GET", url: `/api/agents/${AGENT_ID}/messages` });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SECRET);
    const body = response.json() as { messages: Array<{ content: string; role: string }> };
    expect(body.messages[0]?.content).not.toContain(SECRET);
    expect(body.messages[0]?.role).toBe("agent");
  });

  it("redacts agent.lastError", async () => {
    const app = await appWithTrace(null);

    const response = await app.inject({ method: "GET", url: `/api/agents/${AGENT_ID}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SECRET);
  });

  it("sets no x-redactions header when nothing was redacted", async () => {
    const app = await appWithTrace(null);

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-redactions"]).toBeUndefined();
    expect(response.json()).toEqual({ ok: true, service: "volc-agent-launchpad" });
  });

  // The hook is scoped by content type precisely so it never touches the built
  // UI. A JS bundle can contain a long base64 run in a source map or an inlined
  // asset, and rewriting those bytes would corrupt the bundle for no benefit.
  it("passes non-JSON content types through untouched", async () => {
    const app = await appWithTrace(null);

    const bundle = `export const asset="QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3ODkw";`;
    app.get("/assets/app.js", async (_request, reply) =>
      reply.type("application/javascript").send(bundle),
    );
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/assets/app.js" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(bundle);
    expect(response.headers["x-redactions"]).toBeUndefined();
  });
});
