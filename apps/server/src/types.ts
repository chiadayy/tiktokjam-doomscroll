export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  /** Where this run's raw trace was written, and how big it got. */
  trace: RunTrace | null;
  /**
   * What the guard checks reported for this run. Empty when the guard was off
   * or nothing tripped. Absent on runs recorded before the guard existed.
   */
  findings?: import("./checks.js").Finding[];
  /** True when the guard refused an action or ended this run. */
  intervened?: boolean;
  /** Scenario labels, unset for ordinary runs. See RunEvaluation. */
  evaluation: RunEvaluation | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** Pointer to a run's raw trace file. The content never lives in the database. */
export interface RunTrace {
  /** Path to a JSON Lines file, one protocol message per line. */
  path: string;
  events: number;
  bytes: number;
  /** True when the size cap was reached and later events were dropped. */
  truncated: boolean;
}

/**
 * Labels a run so it can be scored later.
 *
 * These stay null for ordinary use. The harness sets them when running a
 * scenario, because the metrics we care about are properties of a whole run
 * rather than of any single step:
 *
 *   benign utility          task completes with no attack present
 *   utility under attack    task still completes while an attack is running
 *   attack success rate     the attack achieved its goal
 *
 * Adding these after traces exist would mean re-recording every run, so they
 * are here from the start even though nothing sets them yet.
 */
export interface RunEvaluation {
  scenarioId: string;
  attackPresent: boolean;
  /** What the user asked for, in a form a checker can verify. */
  userGoal: string;
  /** What the attack was trying to achieve, if one was present. */
  attackGoal: string | null;
  /** Null until something judges the run. */
  userGoalAchieved: boolean | null;
  attackGoalAchieved: boolean | null;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
  /** Absent for the local-process runner, which is not traced. */
  trace?: RunTrace;
  /** What the guard checks reported. Empty when no checks ran. */
  findings?: import("./checks.js").Finding[];
  /** True when the guard refused an action or ended the run. */
  intervened?: boolean;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  /** Trusted authority context for task-aware monitoring. */
  taskContext: import("./semantic-intent-monitor.js").TrustedTaskContext;
  threadId: string | null;
  /** Optional so the untraced local-process runner stays compatible. */
  runId?: string;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
