// Where deterministic checks are written.
//
// READ THIS FIRST if you are adding a check.
//
// A check is a plain function. It receives the whole trace of a run and returns
// a list of findings. It does not read files, call the network, look at the
// clock, or use randomness. Same trace in, same findings out, every time.
//
// That one restriction is what buys us everything else:
//
//   * You can run a check against a trace file with no agent and no API cost.
//   * You can replay a check written today against a run recorded last week.
//   * You can unit test a check by writing a five line trace by hand.
//   * Live enforcement uses the SAME function, fed the trace so far after each
//     event, so what you tested is exactly what runs.
//
// The raw trace is the source of truth. The helpers near the bottom of this
// file are convenience views over it. They never remove information, so if a
// helper does not give you what you need, read the raw records directly.

import type { TraceRecord } from "./trace.js";

// ---------------------------------------------------------------------------
// What a check produces
// ---------------------------------------------------------------------------

export type Severity = "info" | "warn" | "violation";

export interface Finding {
  /** Name of the check that produced this. */
  check: string;
  /** Machine readable label, for example "read-then-egress". Keep it stable. */
  code: string;
  severity: Severity;
  /** The trace record that triggered the finding. */
  seq: number;
  /**
   * Every trace record that justifies the finding, so a human can open the
   * trace at those lines and judge for themselves. A finding without evidence
   * is only an assertion.
   */
  evidence: number[];
  /** One sentence, written for a person reading a report. */
  message: string;
  /**
   * What to say to the agent when this finding should correct it mid-run.
   *
   * Leave it unset to record the finding without intervening. When set, the
   * enforcement layer sends this text into the running turn (or refuses the
   * pending action), so write it as an instruction the agent can act on: say
   * what is wrong AND what to do instead. A bare "no" tends to make an agent
   * retry the same thing.
   */
  steer?: string;
  /**
   * Machine-extracted values describing what the agent was about to do, for the
   * memory layer to fold into the next run's check options (see reflections.ts).
   *
   * Every value must be lifted verbatim from a structured trace field — a parsed
   * read action's path, a hostname pulled out of a command, a channel name from
   * a fixed enum. Never a span of prose, and never anything a model wrote. A
   * value constrained to a hostname charset cannot carry an instruction; a
   * sentence cannot make that promise. reflections.ts validates every value against
   * a per-key schema and rejects the finding outright if any fails, so a new key
   * has to be added there deliberately.
   *
   * Leave it unset when the finding's only evidence is the agent's own
   * narration. Such a check may steer, but must never author a standing rule:
   * narration is self-reported, and a rule derived from it would outlive the
   * turn that produced it. Omitting `facts` enforces that structurally rather
   * than by convention.
   */
  facts?: Record<string, string>;
}

export interface Check {
  name: string;
  run(trace: TraceRecord[]): Finding[];
}

/**
 * Run every check over a trace and collect the findings.
 *
 * Offline, pass the whole trace. Live, pass the trace so far and call this
 * again after each new event. It is the same code path either way.
 */
export function runChecks(checks: Check[], trace: TraceRecord[]): Finding[] {
  const findings: Finding[] = [];
  for (const check of checks) {
    for (const finding of check.run(trace)) {
      findings.push(finding);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Convenience views over the raw trace
// ---------------------------------------------------------------------------
//
// The agent runtime sends verbose, deeply nested messages. You should not have
// to know that a shell command arrives as an "item/started" whose item.type is
// "commandExecution". These functions flatten the common cases. Each keeps the
// seq number so a finding can point back at the original record.

export interface CommandEvent {
  seq: number;
  itemId: string;
  /** The command as the runtime reported it, usually wrapped in bash -lc. */
  command: string;
  cwd: string | null;
  /** The runtime's own parsing of the command. May be empty. */
  actions: unknown[];
  /** Set only on the completed event. */
  exitCode: number | null;
  output: string | null;
  phase: "started" | "completed";
}

export interface FileChangeEvent {
  seq: number;
  itemId: string;
  path: string;
  /** "add", "delete" or "update". */
  kind: string;
  diff: string;
  phase: "started" | "completed";
}

export interface ApprovalEvent {
  seq: number;
  itemId: string;
  /** What the runtime asked permission for. */
  method: string;
}

/** Every shell command the agent ran, in order. */
export function commandsOf(trace: TraceRecord[]): CommandEvent[] {
  const commands: CommandEvent[] = [];

  for (const record of trace) {
    const phase = itemPhase(record);
    if (phase === null) continue;

    const item = readItem(record);
    if (item === null) continue;
    if (item.type !== "commandExecution") continue;

    commands.push({
      seq: record.seq,
      itemId: asString(item.id) ?? "",
      command: asString(item.command) ?? "",
      cwd: asString(item.cwd),
      actions: Array.isArray(item.commandActions) ? item.commandActions : [],
      exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
      output: asString(item.aggregatedOutput),
      phase: phase,
    });
  }

  return commands;
}

/** Every file the agent created, changed or deleted, in order. */
export function fileChangesOf(trace: TraceRecord[]): FileChangeEvent[] {
  const changes: FileChangeEvent[] = [];

  for (const record of trace) {
    const phase = itemPhase(record);
    if (phase === null) continue;

    const item = readItem(record);
    if (item === null) continue;
    if (item.type !== "fileChange") continue;
    if (!Array.isArray(item.changes)) continue;

    for (const entry of item.changes) {
      const change = entry as Record<string, unknown>;
      changes.push({
        seq: record.seq,
        itemId: asString(item.id) ?? "",
        path: asString(change.path) ?? "",
        kind: readChangeKind(change.kind),
        diff: asString(change.diff) ?? "",
        phase: phase,
      });
    }
  }

  return changes;
}

/**
 * Every file the agent read, according to the runtime's own parsing of the
 * command. This is the runtime's best effort, not ground truth, so a check that
 * needs certainty should also look at the raw command string.
 */
export function readsOf(trace: TraceRecord[]): Array<{ seq: number; path: string }> {
  const reads: Array<{ seq: number; path: string }> = [];

  for (const command of commandsOf(trace)) {
    for (const entry of command.actions) {
      const action = entry as Record<string, unknown>;
      if (action.type !== "read") continue;

      const path = asString(action.path);
      if (path !== null) {
        reads.push({ seq: command.seq, path: path });
      }
    }
  }

  return reads;
}

/** Every point where the runtime paused and asked our permission. */
export function approvalsOf(trace: TraceRecord[]): ApprovalEvent[] {
  const approvals: ApprovalEvent[] = [];

  for (const record of trace) {
    if (record.dir !== "in") continue;
    if (record.method === null) continue;
    if (!record.method.endsWith("/requestApproval")) continue;

    const params = readParams(record);
    approvals.push({
      seq: record.seq,
      itemId: asString(params?.itemId) ?? "",
      method: record.method,
    });
  }

  return approvals;
}

/** The agent's own final message. Self reported, so never decide anything on it. */
export function agentMessagesOf(trace: TraceRecord[]): Array<{ seq: number; text: string }> {
  const messages: Array<{ seq: number; text: string }> = [];

  for (const record of trace) {
    if (record.method !== "item/completed") continue;

    const item = readItem(record);
    if (item === null) continue;
    if (item.type !== "agentMessage") continue;

    const text = asString(item.text);
    if (text !== null) {
      messages.push({ seq: record.seq, text: text });
    }
  }

  return messages;
}

/**
 * The agent's own reasoning narration, one entry per completed reasoning item,
 * in order. This is what the model said it was thinking, not ground truth: a
 * check may record a concern about it, but must not stop a turn on narration
 * alone (see the note on agentMessagesOf).
 *
 * The runtime's reasoning item shape is not fixed. The text may arrive as
 * `text`, or split across `summary` / `content` parts, each part a bare string
 * or an object with a `text` field. This pulls a string out of whichever is
 * present and joins them; if none is, the entry is skipped.
 */
export function reasoningOf(trace: TraceRecord[]): Array<{ seq: number; text: string }> {
  const entries: Array<{ seq: number; text: string }> = [];

  for (const record of trace) {
    if (record.method !== "item/completed") continue;

    const item = readItem(record);
    if (item === null) continue;
    if (item.type !== "reasoning") continue;

    const text = reasoningText(item);
    if (text !== "") {
      entries.push({ seq: record.seq, text: text });
    }
  }

  return entries;
}

/** Best-effort join of every string carried by a reasoning item. */
function reasoningText(item: Record<string, unknown>): string {
  const parts: string[] = [];

  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (!Array.isArray(value)) return;
    for (const element of value) {
      if (typeof element === "string") {
        parts.push(element);
      } else if (element !== null && typeof element === "object") {
        const nested = (element as Record<string, unknown>).text;
        if (typeof nested === "string") parts.push(nested);
      }
    }
  };

  collect(item.text);
  collect(item.summary);
  collect(item.content);

  return parts.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Small helpers for digging into raw payloads
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** "started", "completed", or null when the record is not an item event. */
function itemPhase(record: TraceRecord): "started" | "completed" | null {
  if (record.method === "item/started") return "started";
  if (record.method === "item/completed") return "completed";
  return null;
}

function readParams(record: TraceRecord): Record<string, unknown> | null {
  const payload = record.payload as Record<string, unknown> | null;
  if (payload === null || typeof payload !== "object") return null;

  const params = payload.params;
  if (params === null || typeof params !== "object") return null;
  return params as Record<string, unknown>;
}

function readItem(record: TraceRecord): Record<string, unknown> | null {
  const params = readParams(record);
  if (params === null) return null;

  const item = params.item;
  if (item === null || typeof item !== "object") return null;
  return item as Record<string, unknown>;
}

/** The runtime sends change kinds as { type: "add" } rather than "add". */
function readChangeKind(kind: unknown): string {
  if (kind === null || typeof kind !== "object") return "unknown";
  const type = (kind as Record<string, unknown>).type;
  return typeof type === "string" ? type : "unknown";
}
