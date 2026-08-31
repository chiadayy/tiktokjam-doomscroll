import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isModelConfigured } from "./config.js";
import { HttpError, RunCancelledError, traceOf } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { redactSensitiveText } from "./redaction/index.js";
import type {
  HumanApprovalDecision,
  HumanApprovalDraft,
  HumanApprovalRequest,
  HumanApprovalResolution,
} from "./types.js";

const now = () => new Date().toISOString();

interface PendingApprovalWaiter {
  request: HumanApprovalRequest;
  agentId: string;
  resolve: (resolution: HumanApprovalResolution) => void;
  timer: NodeJS.Timeout | null;
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly pendingApprovals = new Map<string, PendingApprovalWaiter>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (
          run.status === "queued" ||
          run.status === "running" ||
          run.status === "waiting_approval"
        ) {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
        run.pendingApproval = null;
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async resolveApproval(
    runId: string,
    approvalId: string,
    decision: HumanApprovalDecision,
  ): Promise<AgentRun> {
    const waiter = this.pendingApprovals.get(approvalId);
    if (waiter === undefined || waiter.request.runId !== runId) {
      throw new HttpError(409, "Approval is stale or has already been resolved");
    }
    await this.finishApproval(
      waiter,
      decision === "approve"
        ? { decision: "approve", outcome: "approved" }
        : { decision: "deny", outcome: "denied" },
    );
    return this.getRun(runId);
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isModelConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      trace: null,
      findings: [],
      intervened: false,
      pendingApproval: null,
      evaluation: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isModelConfigured(this.config),
      modelProvider: this.config.modelProvider,
      arkBaseUrl:
        this.config.modelProvider === "openai" ? "https://api.openai.com/v1" : this.config.arkBaseUrl,
      arkModel: this.config.modelName || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        taskContext: {
          userPrompt: run.prompt,
          agentInstructions: agentAtStart.instructions,
        },
        threadId: agentAtStart.codexThreadId,
        runId: run.id,
        reflections: agentAtStart.reflections ?? [],
        ...(this.config.hitlEnabled
          ? {
              requestHumanApproval: (approval: HumanApprovalDraft) =>
                this.requestApproval(agentAtStart.id, run.id, approval),
            }
          : {}),
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.trace = result.trace ?? null;
        storedRun.findings = result.findings ?? [];
        storedRun.intervened = result.intervened ?? false;
        storedRun.pendingApproval = null;
        storedRun.completedAt = completedAt;
        // Absent when the reflection guard is off, which must leave whatever is
        // already stored alone rather than clearing it.
        if (result.reflections !== undefined) {
          agent.reflections = result.reflections;
        }
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.trace = traceOf(error);
          storedRun.pendingApproval = null;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.cancelPendingApprovals(agentId);
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }

  private async requestApproval(
    agentId: string,
    runId: string,
    draft: HumanApprovalDraft,
  ): Promise<HumanApprovalResolution> {
    const createdAt = now();
    const request: HumanApprovalRequest = {
      id: randomUUID(),
      runId,
      reason: draft.reason,
      actionType: draft.actionType,
      actionId: boundedSafeText(draft.actionId, 160),
      summary: boundedSafeText(draft.summary, 240),
      ...(draft.safeDetails === undefined
        ? {}
        : { safeDetails: boundedSafeText(draft.safeDetails, 2_000) }),
      createdAt,
      expiresAt: new Date(Date.now() + this.config.hitlTimeoutMs).toISOString(),
    };

    let resolveDecision!: (resolution: HumanApprovalResolution) => void;
    const decision = new Promise<HumanApprovalResolution>((resolve) => {
      resolveDecision = resolve;
    });
    const waiter: PendingApprovalWaiter = {
      request,
      agentId,
      resolve: resolveDecision,
      timer: null,
    };
    this.pendingApprovals.set(request.id, waiter);

    try {
      const opened = await this.store.mutate((database) => {
        const run = database.runs.find((item) => item.id === runId && item.agentId === agentId);
        if (run === undefined || run.status !== "running") return false;
        run.status = "waiting_approval";
        run.pendingApproval = request;
        return true;
      });
      if (!opened) {
        this.pendingApprovals.delete(request.id);
        resolveDecision({ decision: "deny", outcome: "cancelled" });
        return decision;
      }

      // Cancellation may have settled the waiter while the serialized store
      // mutation was opening it. In that case its queued cleanup owns state.
      if (!this.pendingApprovals.has(request.id)) return decision;
      waiter.timer = setTimeout(() => {
        void this.finishApproval(waiter, { decision: "deny", outcome: "timed_out" }).catch(
          () => undefined,
        );
      }, this.config.hitlTimeoutMs);
      waiter.timer.unref();
      return decision;
    } catch (error) {
      this.pendingApprovals.delete(request.id);
      resolveDecision({ decision: "deny", outcome: "cancelled" });
      throw error;
    }
  }

  private async finishApproval(
    waiter: PendingApprovalWaiter,
    resolution: HumanApprovalResolution,
  ): Promise<void> {
    if (!this.pendingApprovals.delete(waiter.request.id)) return;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    try {
      await this.store.mutate((database) => {
        const run = database.runs.find((item) => item.id === waiter.request.runId);
        if (run === undefined) return;
        if (run.pendingApproval?.id === waiter.request.id) run.pendingApproval = null;
        if (run.status === "waiting_approval") run.status = "running";
      });
    } finally {
      waiter.resolve(resolution);
    }
  }

  private async cancelPendingApprovals(agentId: string): Promise<void> {
    const waiters = [...this.pendingApprovals.values()].filter(
      (waiter) => waiter.agentId === agentId,
    );
    await Promise.all(
      waiters.map((waiter) =>
        this.finishApproval(waiter, { decision: "deny", outcome: "cancelled" }),
      ),
    );
  }
}

function boundedSafeText(text: string, maximum: number): string {
  const safe = redactSensitiveText(text).replace(/\0/g, "").trim();
  return safe.length <= maximum ? safe : safe.slice(0, maximum - 1) + "…";
}
