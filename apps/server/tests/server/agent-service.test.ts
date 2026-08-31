import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../../src/agent-service.js";
import { loadConfig } from "../../src/config.js";
import { JsonStore } from "../../src/store.js";
import { RunCancelledError } from "../../src/errors.js";
import type {
  AgentRunner,
  HumanApprovalResolution,
  RunnerRequest,
  RunnerResult,
} from "../../src/types.js";
import { WorkspaceManager } from "../../src/workspace.js";

class FakeRunner implements AgentRunner {
  lastRequest: RunnerRequest | null = null;

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.lastRequest = request;
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  environment: NodeJS.ProcessEnv = {},
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...environment,
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("passes the original prompt and Agent instructions as trusted task context", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({
      name: "Guarded coder",
      instructions: "Preserve authentication behaviour.",
    });
    const { run } = await service.sendMessage(agent.id, "Fix the timeout.");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(runner.lastRequest?.taskContext).toEqual({
      userPrompt: "Fix the timeout.",
      agentInstructions: "Preserve authentication behaviour.",
    });
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("persists one pending approval, resolves it once, and rejects replay", async () => {
    let resolution: HumanApprovalResolution | null = null;
    const runner: AgentRunner = {
      run: async (request) => {
        resolution = await request.requestHumanApproval?.({
          reason: "high_consequence",
          actionType: "command",
          actionId: "push-1",
          summary: "Run: git push origin main",
          safeDetails: "git push origin main",
        }) ?? null;
        return { output: "continued", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner, { HITL_ENABLED: "true", HITL_TIMEOUT_MS: "5000" });
    const agent = await service.createAgent({ name: "Approver" });
    const { run } = await service.sendMessage(agent.id, "publish the branch");

    await expect.poll(() => service.getRun(run.id).status).toBe("waiting_approval");
    const pending = service.getRun(run.id).pendingApproval;
    expect(pending).toEqual(
      expect.objectContaining({ reason: "high_consequence", runId: run.id }),
    );
    if (pending === null || pending === undefined) throw new Error("approval was not persisted");

    const resumed = await service.resolveApproval(run.id, pending.id, "approve");
    expect(resumed.pendingApproval).toBeNull();
    expect(["running", "completed"]).toContain(resumed.status);
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(resolution).toEqual({ decision: "approve", outcome: "approved" });
    await expect(service.resolveApproval(run.id, pending.id, "approve")).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("times out an approval, clears it, and lets the run continue", async () => {
    let resolution: HumanApprovalResolution | null = null;
    const service = await makeService(
      {
        run: async (request) => {
          resolution = await request.requestHumanApproval?.({
            reason: "high_consequence",
            actionType: "command",
            actionId: "deploy-1",
            summary: "Run: terraform apply",
          }) ?? null;
          return { output: "continued without deploy", threadId: "thread", usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      { HITL_ENABLED: "true", HITL_TIMEOUT_MS: "1000" },
    );
    const agent = await service.createAgent({ name: "Timeout" });
    const { run } = await service.sendMessage(agent.id, "deploy");

    await expect.poll(() => service.getRun(run.id).status).toBe("waiting_approval");
    await expect.poll(() => service.getRun(run.id).status, { timeout: 3000 }).toBe("completed");
    expect(service.getRun(run.id).pendingApproval).toBeNull();
    expect(resolution).toEqual({ decision: "deny", outcome: "timed_out" });
  });

  it("resolves a pending waiter when the Agent is stopped", async () => {
    let cancelled = false;
    let resolution: HumanApprovalResolution | null = null;
    const service = await makeService(
      {
        run: async (request) => {
          resolution = await request.requestHumanApproval?.({
            reason: "high_consequence",
            actionType: "command",
            actionId: "push-1",
            summary: "Run: git push origin main",
          }) ?? null;
          if (cancelled) throw new RunCancelledError();
          return { output: "continued", threadId: "thread", usage: null };
        },
        cancel: async () => {
          cancelled = true;
          return true;
        },
        isAvailable: async () => true,
      },
      { HITL_ENABLED: "true", HITL_TIMEOUT_MS: "5000" },
    );
    const agent = await service.createAgent({ name: "Stopper" });
    const { run } = await service.sendMessage(agent.id, "publish");
    await expect.poll(() => service.getRun(run.id).status).toBe("waiting_approval");

    await service.stopAgent(agent.id);

    expect(resolution).toEqual({ decision: "deny", outcome: "cancelled" });
    expect(service.getRun(run.id).pendingApproval).toBeNull();
    expect(service.getAgent(agent.id).status).toBe("stopped");
  });

  it("reconciles a persisted waiting approval on startup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
    temporaryDirectories.push(root);
    const dataPath = path.join(root, "data", "db.json");
    const store = new JsonStore(dataPath);
    await store.initialize();
    const timestamp = "2026-08-31T00:00:00.000Z";
    await store.mutate((database) => {
      database.agents.push({
        id: "agent-1",
        name: "Restarted",
        description: "",
        instructions: "",
        status: "busy",
        workspacePath: path.join(root, "workspaces", "agent-1"),
        codexThreadId: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      database.runs.push({
        id: "run-1",
        agentId: "agent-1",
        status: "waiting_approval",
        prompt: "deploy",
        output: null,
        error: null,
        usage: null,
        trace: null,
        findings: [],
        intervened: false,
        pendingApproval: {
          id: "approval-1",
          runId: "run-1",
          reason: "high_consequence",
          actionType: "command",
          actionId: "deploy-1",
          summary: "Run: terraform apply",
          createdAt: timestamp,
          expiresAt: timestamp,
        },
        evaluation: null,
        startedAt: timestamp,
        completedAt: null,
        createdAt: timestamp,
      });
    });
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const service = new AgentService(
      config,
      store,
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
    );

    await service.initialize();

    expect(service.getRun("run-1")).toEqual(
      expect.objectContaining({ status: "cancelled", pendingApproval: null }),
    );
    expect(service.getAgent("agent-1").status).toBe("ready");
  });
});
