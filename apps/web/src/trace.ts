// Turns a raw trace file into something you can put on screen.
//
// The server writes one JSON object per line, each wrapping an untouched
// protocol message. That format is right for storage and for checks, but it is
// too verbose to read directly, so this flattens it into a list of steps.
//
// Nothing here is authoritative. If a step looks wrong, the raw record is still
// in the file and still wins.

export interface TraceRecord {
  seq: number;
  at: string;
  dir: "in" | "out";
  method: string | null;
  payload: unknown;
}

export type StepKind =
  | "command"
  | "file"
  | "search"
  | "thinking"
  | "reply"
  | "approval"
  | "steer"
  | "problem";

export interface TraceStep {
  seq: number;
  at: string;
  kind: StepKind;
  /** The one line a person reads. */
  title: string;
  /** Optional second line: output, a diff summary, a reason. */
  detail: string | null;
  /** "ok", "failed", or null while still running. */
  outcome: string | null;
  files?: FileChangeSummary[];
}

export interface FileChangeSummary {
  path: string;
  kind: "added" | "updated" | "deleted";
  additions: number | null;
  deletions: number | null;
  diff: string | null;
  truncated: boolean;
}

export const MAX_ACTIVITY_DIFF_CHARS = 8_000;

/** Split a JSON Lines response into records, skipping anything unparseable. */
export function parseTrace(text: string): TraceRecord[] {
  const records: TraceRecord[] = [];

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as TraceRecord);
    } catch {
      // A partially written last line is normal while a run is in flight.
    }
  }

  return records;
}

/** Everything the flattening needs to remember as it walks the records. */
interface Building {
  steps: TraceStep[];
  /** Items already seen, so a start and its completion become one step. */
  stepByItemId: Map<string, TraceStep>;
  /** Approval requests waiting for our reply, keyed by JSON-RPC id. */
  pendingApprovals: Map<string, TraceStep>;
}

/**
 * Flatten records into steps.
 *
 * Each handler below takes one record and returns true if it dealt with it.
 * The first one that matches wins, so the order here is the priority order.
 */
export function toSteps(records: TraceRecord[]): TraceStep[] {
  const building: Building = {
    steps: [],
    stepByItemId: new Map(),
    pendingApprovals: new Map(),
  };

  for (const record of records) {
    if (handleItemEvent(record, building)) continue;
    if (handleApprovalRequest(record, building)) continue;
    if (handleOurDecision(record, building)) continue;
    if (handleSteer(record, building)) continue;
    handleError(record, building);
  }

  return building.steps;
}

/** A thing the agent did: a command, a file change, a search, a reply. */
function handleItemEvent(record: TraceRecord, building: Building): boolean {
  if (record.method !== "item/started" && record.method !== "item/completed") return false;

  const item = readItem(record);
  if (item === null) return false;

  addOrUpdateItemStep(building.steps, building.stepByItemId, record, item);
  return true;
}

/**
 * The runtime pausing to ask permission. Our answer arrives later as its own
 * record, so hold this step and fill in the real decision when it does.
 */
function handleApprovalRequest(record: TraceRecord, building: Building): boolean {
  if (record.dir !== "in") return false;
  if (record.method?.endsWith("/requestApproval") !== true) return false;

  const step: TraceStep = {
    seq: record.seq,
    at: record.at,
    kind: "approval",
    title: "Runtime asked permission",
    detail: "Waiting for a decision…",
    outcome: null,
  };
  building.steps.push(step);

  const requestId = readMessageId(record);
  if (requestId !== null) building.pendingApprovals.set(requestId, step);
  return true;
}

/**
 * Our reply to an approval request. This is the middleware acting, so it shows
 * the decision we actually sent rather than an assumption about it.
 */
function handleOurDecision(record: TraceRecord, building: Building): boolean {
  if (record.dir !== "out") return false;

  const decision = readDecision(record);
  const requestId = readMessageId(record);
  if (decision === null || requestId === null) return false;

  const waiting = building.pendingApprovals.get(requestId);
  if (waiting === undefined) return false;

  waiting.detail = describeDecision(decision);
  waiting.outcome = decision === "accept" ? "allowed" : "blocked";
  building.pendingApprovals.delete(requestId);
  return true;
}

/**
 * A correction sent into a turn already in progress. This is the moment the
 * middleware changes what the agent is doing, so it gets its own step.
 */
function handleSteer(record: TraceRecord, building: Building): boolean {
  if (record.dir !== "out") return false;
  if (record.method !== "turn/steer") return false;

  building.steps.push({
    seq: record.seq,
    at: record.at,
    kind: "steer",
    title: "Steered by middleware",
    detail: readSteerText(record),
    outcome: null,
  });
  return true;
}

function handleError(record: TraceRecord, building: Building): void {
  if (record.method !== "error") return;

  building.steps.push({
    seq: record.seq,
    at: record.at,
    kind: "problem",
    title: "Error",
    detail: readErrorMessage(record),
    outcome: "failed",
  });
}

function addOrUpdateItemStep(
  steps: TraceStep[],
  stepByItemId: Map<string, TraceStep>,
  record: TraceRecord,
  item: Record<string, unknown>,
): void {
  const itemId = asString(item.id);
  const existing = itemId === null ? undefined : stepByItemId.get(itemId);

  if (existing !== undefined) {
    updateOutcome(existing, item);
    if (record.method === "item/completed" && existing.outcome === null) {
      existing.outcome = "ok";
    }
    return;
  }

  const step = describeItem(record, item);
  if (step === null) return;

  steps.push(step);
  if (itemId !== null) stepByItemId.set(itemId, step);
}

function describeItem(record: TraceRecord, item: Record<string, unknown>): TraceStep | null {
  const base = { seq: record.seq, at: record.at, detail: null, outcome: null };

  if (item.type === "commandExecution") {
    return {
      ...base,
      kind: "command",
      title: readableCommand(asString(item.command) ?? ""),
      detail: null,
      outcome: null,
    };
  }

  if (item.type === "fileChange") {
    const files = fileChangesFromItem(item);
    return {
      ...base,
      kind: "file",
      title: files.length === 1 ? `${files[0]?.kind} ${files[0]?.path}` : "Files changed",
      detail: null,
      outcome: null,
      files,
    };
  }

  // A web search is an outbound network call, so it matters for anything
  // watching what leaves the machine.
  if (item.type === "webSearch") {
    const query = asString(item.query);
    return {
      ...base,
      kind: "search",
      title: query === null ? "Web search" : `Searched: ${query}`,
      detail: null,
      outcome: null,
    };
  }

  if (item.type === "agentMessage") {
    return { ...base, kind: "reply", title: "Replied", detail: asString(item.text), outcome: null };
  }

  if (item.type === "reasoning") {
    return {
      ...base,
      kind: "thinking",
      title: "Thinking",
      detail: reasoningDetail(item),
      outcome: null,
    };
  }

  return null;
}

function updateOutcome(step: TraceStep, item: Record<string, unknown>): void {
  const exitCode = item.exitCode;
  if (typeof exitCode === "number") {
    step.outcome = exitCode === 0 ? "ok" : "failed";
  }

  const output = asString(item.aggregatedOutput);
  if (output !== null && output.trim() !== "") {
    step.detail = output.trim().split("\n").slice(0, 3).join("\n");
  }

  if (item.type === "reasoning") {
    const reasoning = reasoningDetail(item);
    if (reasoning !== null) step.detail = reasoning;
    return;
  }

  const text = asString(item.text);
  if (text !== null) step.detail = text;
}

/**
 * The agent's reasoning narration, retained for technical inspection. The
 * default activity view deliberately renders only a compact Reasoning row.
 * The runtime's reasoning item is not a fixed shape: the text may be `text`, or
 * spread across `summary` / `content` parts that are strings or `{ text }`
 * objects. Pull a string out of whichever is there.
 */
function reasoningDetail(item: Record<string, unknown>): string | null {
  const parts: string[] = [];

  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (!Array.isArray(value)) return;
    for (const element of value) {
      if (typeof element === "string") parts.push(element);
      else if (element !== null && typeof element === "object") {
        const nested = (element as Record<string, unknown>).text;
        if (typeof nested === "string") parts.push(nested);
      }
    }
  };

  collect(item.text);
  collect(item.summary);
  collect(item.content);

  const joined = parts.join("\n").trim();
  if (joined === "") return null;
  return joined.split("\n").slice(0, 4).join("\n");
}

/**
 * The runtime wraps everything as `/bin/bash -lc '...'`. Showing that wrapper
 * on every line makes the list unreadable, so strip it for display only.
 */
export function readableCommand(command: string): string {
  const match = /^(?:\S*\/)?(?:sh|bash|zsh)\s+(?:-\S+\s+)*(['"])([\s\S]*)\1$/.exec(command.trim());
  if (match?.[2] !== undefined) return match[2].trim();
  return command.trim();
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readItem(record: TraceRecord): Record<string, unknown> | null {
  const payload = record.payload as Record<string, unknown> | null;
  if (payload === null || typeof payload !== "object") return null;

  const params = payload.params as Record<string, unknown> | undefined;
  if (params === undefined || typeof params !== "object") return null;

  const item = params.item;
  if (item === null || typeof item !== "object") return null;
  return item as Record<string, unknown>;
}

function readErrorMessage(record: TraceRecord): string | null {
  const payload = record.payload as Record<string, unknown> | null;
  const params = payload?.params as Record<string, unknown> | undefined;
  const error = params?.error as Record<string, unknown> | undefined;
  return asString(error?.message);
}

function readChangeKind(kind: unknown): string {
  if (kind === null || typeof kind !== "object") return "changed";
  const type = (kind as Record<string, unknown>).type;
  return typeof type === "string" ? type : "changed";
}

/** Derive a bounded, per-file display model from one Runtime fileChange item. */
export function fileChangesFromItem(item: Record<string, unknown>): FileChangeSummary[] {
  if (!Array.isArray(item.changes)) return [];
  return item.changes.map((entry) => {
    const change = entry as Record<string, unknown>;
    const sourceKind = readChangeKind(change.kind);
    const rawDiff = asString(change.diff);
    const diff = rawDiff === null ? null : boundDiff(rawDiff);
    const counts = rawDiff === null ? null : diffCounts(rawDiff, sourceKind);
    return {
      path: asString(change.path) ?? "Unnamed file",
      kind: displayChangeKind(sourceKind),
      additions: counts?.additions ?? null,
      deletions: counts?.deletions ?? null,
      diff,
      truncated: rawDiff !== null && rawDiff.length > MAX_ACTIVITY_DIFF_CHARS,
    };
  });
}

function displayChangeKind(kind: string): FileChangeSummary["kind"] {
  if (kind === "add") return "added";
  if (kind === "delete") return "deleted";
  return "updated";
}

/**
 * Runtime updates use unified-diff markers, but new/deleted files arrive as
 * raw file content. Count the latter as physical lines rather than looking
 * for prefixes that are not present.
 */
export function diffCounts(
  diff: string,
  changeKind = "update",
): { additions: number; deletions: number } {
  if (changeKind === "add") return { additions: physicalLineCount(diff), deletions: 0 };
  if (changeKind === "delete") return { additions: 0, deletions: physicalLineCount(diff) };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function physicalLineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split(/\r?\n/);
  // A trailing newline terminates the final line; it is not another blank line.
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function boundDiff(diff: string): string {
  return diff.length <= MAX_ACTIVITY_DIFF_CHARS
    ? diff
    : diff.slice(0, MAX_ACTIVITY_DIFF_CHARS) + "\n… diff truncated in activity view";
}


/**
 * Streaming deltas: the model's output arriving token by token.
 *
 * They are the bulk of a trace (a single short reply produced 168 of 344
 * records) and say nothing a reader cannot get from the completed item, so the
 * raw view hides them unless asked. They stay in the file either way.
 */
export function isStreamingNoise(record: TraceRecord): boolean {
  const method = record.method;
  if (method === null) return false;
  return (
    method.endsWith("/delta") ||
    method.includes("Delta") ||
    method.includes("_delta") ||
    method.endsWith("summaryPartAdded") ||
    method.endsWith("section_break")
  );
}

/** Our own messages: the handshake, and later any interception we perform. */
export function isOurs(record: TraceRecord): boolean {
  return record.dir === "out";
}


/** JSON-RPC id, as a string, so requests and replies can be paired. */
function readMessageId(record: TraceRecord): string | null {
  const payload = record.payload as Record<string, unknown> | null;
  if (payload === null || typeof payload !== "object") return null;
  const id = payload.id;
  if (typeof id === "number" || typeof id === "string") return String(id);
  return null;
}

/** The decision we sent back: accept, decline, cancel. */
function readDecision(record: TraceRecord): string | null {
  const payload = record.payload as Record<string, unknown> | null;
  const result = payload?.result as Record<string, unknown> | undefined;
  const decision = result?.decision;
  return typeof decision === "string" ? decision : null;
}

function describeDecision(decision: string): string {
  if (decision === "accept") return "Allowed by the middleware";
  if (decision === "decline") return "Refused. The agent continues without this action.";
  if (decision === "cancel") return "Refused, and the turn was ended.";
  return `Answered: ${decision}`;
}

/** The correction text we injected into a running turn. */
function readSteerText(record: TraceRecord): string | null {
  const payload = record.payload as Record<string, unknown> | null;
  const params = payload?.params as Record<string, unknown> | undefined;
  const input = params?.input;
  if (!Array.isArray(input)) return null;

  const parts: string[] = [];
  for (const entry of input) {
    const text = (entry as Record<string, unknown>).text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.length === 0 ? null : parts.join(" ");
}
