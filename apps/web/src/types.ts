export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  /** What this Agent has been stopped for before. Absent until it learns something. */
  reflections?: Reflection[];
  createdAt: string;
  updatedAt: string;
}

/** A standing rule this Agent carries, stored as values rather than prose. */
export interface Reflection {
  code: string;
  facts: Record<string, string>;
  /** Runs that produced it, oldest first. */
  sightings: string[];
  /**
   * Conversations it was seen in. Two or more is the stronger signal — the second
   * conversation knew nothing of the first. Absent on records written before this
   * was tracked.
   */
  threads?: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface Finding {
  check: string;
  code: string;
  severity: "info" | "warn" | "violation";
  seq: number;
  evidence: number[];
  message: string;
  steer?: string;
  requestSteer?: boolean;
  steerStrength?: "normal" | "firm";
  /** Compact derived audit data emitted by semantic guard findings. */
  metadata?: Record<string, unknown>;
  facts?: Record<string, string>;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  trace: { path: string; events: number; bytes: number; truncated: boolean } | null;
  /** What the guards reported for this run. */
  findings?: Finding[];
  /** True when a guard refused an action or ended the run. */
  intervened?: boolean;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
