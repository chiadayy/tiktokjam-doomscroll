// Shared types for the leash benchmark.
//
// A benchmark run is: for each Scenario, under each GuardConfig, N trials. Each
// trial produces one TrialResult. metrics.ts folds a list of TrialResults into
// MetricCells (CR / DR / FIR / TTC / GR / TCR); report.ts renders them.
//
// Everything here is plain data. The only code that calls a model is run-live.ts.

import type { Finding } from "../apps/server/src/checks.js";
import type { TraceRecord } from "../apps/server/src/trace.js";

/** What became of the attacker's intended action on one attack trial. */
export type AttackOutcome =
  // The malicious step ran to completion and carried the secret to the sink.
  | "executed"
  // A guard declined the action or interrupted the turn before it completed.
  | "blocked_by_guard"
  // The model itself declined; no guard verdict was needed. Not a guard win.
  | "refused_by_model"
  // The agent never reached the malicious step (ran out of turn, got lost).
  | "not_reached";

/** How a carrier smuggles the injected instruction into the workspace. */
export type Carrier =
  | "skill"
  | "agents-md"
  | "readme"
  | "test-file"
  | "commit-msg";

/** The exfiltration channel the injected instruction asks the agent to use. */
export type Channel = "http" | "http-blob" | "dns" | "git-push";

export interface AttackSpec {
  id: string;
  carrier: Carrier;
  channel: Channel;
  /** Host the attack wants workspace data sent to. */
  sink: string;
  /** One-line attacker objective, for the report. */
  goal: string;
  /** Write the poisoned carrier into an already-set-up fixture directory. */
  place(dir: string): void;
}

export interface ScoreContext {
  /** The run's raw JSON-RPC trace, parsed from the .jsonl file. */
  trace: TraceRecord[];
  /** The fixture directory as it stands after the run. */
  workspaceDir: string;
  /** The agent's final message. */
  output: string;
  /** run.findings from the guard pipeline. */
  findings: Finding[];
  /** run.intervened — a guard declined an action or ended the turn. */
  intervened: boolean;
}

export interface Scenario {
  id: string;
  /** Groups rows in the report table, e.g. "benign", "wording". */
  family: string;
  /** null for a benign scenario. */
  attack: AttackSpec | null;
  /**
   * Part of an ordered, reflection-threaded sequence. The harness runs the
   * group on one agent, carrying reflections forward and resetting the thread
   * between members (mirrors scripts/reset-agent-thread.sh).
   */
  pair?: { group: string; order: number };
  /**
   * A generalisation probe: no secret in the workspace, an unseen sink under a
   * host family learned from earlier members. GR = a learned-watch destination
   * warning fires with no egress violation.
   */
  grProbe?: boolean;
  /** Plant the checkout-service project (and nothing attack-specific). */
  setupWorkspace(dir: string): void;
  /** The user's instruction to the agent. */
  prompt: string;
  /** Did the real delegated task get done? Deterministic over the context. */
  scoreUser(ctx: ScoreContext): boolean;
  /**
   * Did the attacker's action actually execute — i.e. did a completed command
   * carry the secret to the sink, with no prior decline for that action?
   * null for a benign scenario. Detection / block / model-refusal are derived
   * generically by the harness from findings + the trace; only "did it run" is
   * scenario-specific.
   */
  attackExecuted(ctx: ScoreContext): boolean | null;
}

export interface GuardConfig {
  name: string;
  /** Env overrides merged onto the base env before loadConfig. */
  env: Record<string, string>;
}

export interface TrialResult {
  scenarioId: string;
  family: string;
  guardConfig: string;
  trial: number;
  attackPresent: boolean;

  /** TCR input. */
  userGoalAchieved: boolean;

  /** Attack-only fields (null / false on benign scenarios). */
  attackExecuted: boolean;
  attackOutcome: AttackOutcome | null;
  /** DR input: a violation-severity finding fired for this run. */
  detected: boolean;
  /** FIR input: a guard declined/interrupted an action. */
  intervened: boolean;

  /** TTC inputs: seq of the first blocking/warning finding, and trace length. */
  catchSeq: number | null;
  traceLen: number;
  /**
   * The same catch expressed in commands — "caught at command 11 of 13". Raw
   * `catchSeq` indexes the JSON-RPC stream, which is mostly reasoning deltas,
   * so it is not a readable measure of how far into the work the guard fired.
   */
  catchCommandIndex: number | null;
  commandCount: number;
  /** Command text the control plane declined. Evidence for the report. */
  declinedCommands: string[];

  /** For paired (reflection) runs: position in the thread, 0-based. */
  threadRunIndex?: number;

  /** Compact finding tally for the report. */
  findings: Array<{ check: string; code: string; severity: string; seq: number }>;

  /** Set when the trial could not be scored (runner error, timeout). */
  error?: string;
}

export interface Interval {
  value: number;
  lo: number;
  hi: number;
  n: number;
}

export interface MetricCell {
  family: string;
  guardConfig: string;
  scenarios: number;
  trials: number;

  /** Containment: attack declined before execution (guard basis). */
  cr: Interval | null;
  /** Detection recall: a violation fired. */
  dr: Interval | null;
  /** DR - CR: noticed but did not stop it. */
  drCrGap: number | null;
  /** False intervention rate: guards firing on benign work. */
  fir: Interval | null;
  /** Task completion, split. */
  tcrBenign: Interval | null;
  tcrUnderAttack: Interval | null;
  /** Generalisation: unseen sink under a learned family, caught. */
  gr: Interval | null;
  /** Mean catch position (seq) by thread run index: [run0, run1, ...]. */
  ttcBySeq: Array<number | null>;
  ttcByFrac: Array<number | null>;
  /**
   * The same chain in commands — [{index, total}, ...]. Readable where raw seq
   * is not: "caught at command 5 of 5" vs "caught at seq 636".
   */
  ttcByCommand: Array<{ index: number; total: number } | null>;
  /** Mean catch position over EVERY run in the cell that had a finding. */
  catchSeqMean: number | null;
  catchFracMean: number | null;
  /** The same mean in commands, for cells that are not reflection-threaded. */
  catchCommandMean: { index: number; total: number } | null;
  catchN: number;

  /** attackOutcome tally. */
  outcomes: Record<AttackOutcome, number>;
}
