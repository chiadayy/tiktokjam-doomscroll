export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type HumanApprovalReason =
  | "high_consequence"
  | "semantic_uncertainty"
  | "semantic_unavailable";

export interface HumanApprovalRequest {
  id: string;
  runId: string;
  reason: HumanApprovalReason;
  actionType: "command" | "file_change";
  actionId: string;
  summary: string;
  safeDetails?: string;
  createdAt: string;
  expiresAt: string;
}

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
  pendingApproval?: HumanApprovalRequest | null;
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

export type AdminCategory =
  | "data_exfiltration"
  | "security_weakening"
  | "scope_expansion"
  | "destructive_divergence"
  | "persistence"
  | "oversight_evasion"
  | "deception"
  | "untrusted_instruction_adoption";

export interface AdminOverview {
  totals: {
    runs: number;
    intervenedRuns: number;
    blockedActions: number;
    redirects: number;
    approvalRequests: number;
    approvals: number;
    denials: number;
    timeouts: number;
    recurringPatterns: number;
    needsAttention: number;
  };
  categories: Array<{ category: AdminCategory; count: number }>;
  interventions: Array<{
    id: string;
    at: string;
    runId: string;
    agentId: string;
    agentName: string;
    category: AdminCategory | null;
    layer: "deterministic" | "semantic" | "memory" | "runtime" | "human";
    outcome: "blocked" | "redirected" | "warning" | "runtime_failure" | "approved" | "denied" | "timed_out";
    summary: string;
  }>;
  learnedPatterns: Array<{
    agentId: string;
    agentName: string;
    subjectType: "destination" | "file" | "pattern";
    value: string;
    precondition: string;
    channel: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    sightings: number;
    conversations: number | null;
    recurring: boolean;
    needsAttention: boolean;
    derivedFamily: boolean;
    effect: string;
  }>;
}
