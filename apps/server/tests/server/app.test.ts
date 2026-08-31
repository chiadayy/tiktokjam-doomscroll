import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { HttpError } from "../../src/errors.js";
import type { AgentService } from "../../src/agent-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("resolves a one-shot run approval through the narrow API", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const approvalId = "22222222-2222-4222-8222-222222222222";
    const calls: unknown[] = [];
    const approvalService = {
      resolveApproval: async (...args: unknown[]) => {
        calls.push(args);
        return { id: runId, status: "running", pendingApproval: null };
      },
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), approvalService);

    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/approval`,
      payload: { approvalId, decision: "approve" },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([[runId, approvalId, "approve"]]);
    expect(response.json()).toEqual({
      run: expect.objectContaining({ id: runId, status: "running", pendingApproval: null }),
    });
    await app.close();
  });

  it("returns conflict for a stale approval id", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const approvalId = "22222222-2222-4222-8222-222222222222";
    const approvalService = {
      resolveApproval: async () => {
        throw new HttpError(409, "Approval is stale or has already been resolved");
      },
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), approvalService);

    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/approval`,
      payload: { approvalId, decision: "deny" },
    });

    expect(response.statusCode).toBe(409);
    await app.close();
  });
});
