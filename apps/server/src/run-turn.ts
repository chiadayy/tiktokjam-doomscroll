// Drives one turn of an agent and records everything it does.
//
// With neither `checks` nor an `intentController` it decides nothing: every
// permission request is accepted, no action is refused, no correction is sent,
// and the agent runs exactly as it would if nobody were watching. That remains
// the default.
//
// When `checks` are passed it becomes the enforcement point. After each
// recorded action the checks run over the trace so far; a `violation` with a
// `steer` string is sent into the live turn as a correction, and a `violation`
// on a command still waiting for permission is refused outright with `cancel`
// (an atomic decline-and-interrupt). An optional task-aware controller reviews
// only meaningful semantic checkpoints. This file remains the sole place that
// carries either verdict onto the wire.

import type { JsonRpcConnection } from "./codex-app-server-client.js";
import type { AskForApproval } from "./codex-protocol.js";
import {
  commandsOf,
  fileChangesOf,
  runChecks,
  type Check,
  type Finding,
} from "./checks.js";
import type { IntentController, IntentControllerResult } from "./intent-controller.js";
import type { SemanticProposedAction } from "./semantic-intent-monitor.js";
import type { TraceRecord } from "./trace.js";
import type { RunUsage } from "./types.js";

/**
 * Most corrections one turn may receive from the deterministic checks.
 *
 * Small on purpose. A steer is not a log line — it is text pushed into the
 * conversation the Agent is mid-way through, so several in a row stop reading
 * as a correction and start reading as a new task.
 */
export const MAX_STEERS_PER_TURN = 3;

export interface TurnOptions {
  rpc: JsonRpcConnection;
  prompt: string;
  /** Null starts a new conversation; a value continues an existing one. */
  threadId: string | null;
  /** Mirrors CODEX_SANDBOX_MODE. */
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  /**
   * Checks to run as the trace grows. Empty (the default) means observe
   * without intervening.
   */
  checks?: Check[];
  /**
   * The run's trace, the same array the caller appends to as messages arrive.
   * Checks read it. Required for `checks` to see anything.
   */
  trace?: TraceRecord[];
  /**
   * Deny network access in the sandbox so a command that reaches out escalates
   * to a permission request this turn can inspect. Pair it with `checks`.
   */
  denyNetwork?: boolean;
  /**
   * What to do when a check returns a `violation` on an action that is already
   * running (seen at `item/started` or later):
   *   "interrupt"  end the turn at once with `turn/interrupt`. The default.
   *   "steer-only" inject the correction text and let the turn continue.
   * A command still waiting on approval is always refused with `decline`
   * regardless of this, since that needs no interrupt.
   */
  onViolation?: "interrupt" | "steer-only";
  /** Optional task-aware semantic policy. Separate from deterministic checks. */
  intentController?: IntentController;
  /** Pinned-runtime approval behavior to apply to this thread and turn. */
  approvalPolicy?: AskForApproval;
  /**
   * The Runtime was configured to make workspace writes approval-gated.
   * This enables only a narrow audit backstop; it is not a substitute for the
   * OS/runtime boundary.
   */
  semanticEnforcement?: boolean;
}

export interface TurnOutcome {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
  /** Everything the checks reported, in the order it was found. */
  findings: Finding[];
  /** True if a check refused an action or ended the turn during this run. */
  intervened: boolean;
}

export async function runTurn(options: TurnOptions): Promise<TurnOutcome> {
  const rpc = options.rpc;
  const checks = options.checks ?? [];
  const records = options.trace ?? [];
  const onViolation = options.onViolation ?? "interrupt";
  const intentController = options.intentController;
  const semanticEnforcement = options.semanticEnforcement ?? false;

  // Collected as notifications arrive.
  const messages: string[] = [];
  let usage: RunUsage | null = null;
  let turnFailure: string | null = null;

  // Findings the checks have produced, and the keys of ones already acted on.
  const findings: Finding[] = [];
  const actedOn = new Set<string>();
  let intervened = false;
  let interruptSent = false;
  let liveThreadId: string | null = options.threadId;
  let turnId: string | null = null;
  // Notification callbacks cannot await model calls. Chain them explicitly so
  // an approval waits for every earlier reasoning assessment in trace order.
  let semanticQueue: Promise<void> = Promise.resolve();
  // A requestApproval means Codex is paused. For file changes, v0.111.0 emits
  // item/started before this request, so completion is the first reliable
  // point at which a missing gate can be diagnosed without false positives.
  const approvalGates = new Set<string>();

  // A violation fires once per turn (coarser key); anything lower is per record.
  const keyOf = (finding: Finding): string =>
    finding.severity === "violation"
      ? `${finding.check}:${finding.code}`
      : `${finding.check}:${finding.code}:${finding.seq}`;

  // Every steer is text injected into the turn the agent is still working in,
  // so it costs tokens and competes with the task for attention. Violations are
  // deduped once per turn, but warns are keyed per record — an Agent that reads
  // four watched files produces four of them. Cap the deterministic checks so a
  // memory with several matches corrects the Agent rather than talking over it.
  // Findings past the cap are still recorded; only delivery stops.
  let steersSent = 0;

  function sendSteerWithinBudget(text: string): void {
    if (steersSent >= MAX_STEERS_PER_TURN) return;
    steersSent += 1;
    sendSteer(text);
  }

  /**
   * Run the checks over `trace` and act on anything new.
   *
   * @param enforce when true, a finding triggers the configured response. The
   *   approval handler passes false because it answers on the wire itself.
   */
  function review(trace: TraceRecord[], enforce: boolean): Finding[] {
    if (checks.length === 0) return [];
    const found = runChecks(checks, trace);
    for (const finding of found) {
      const key = keyOf(finding);
      if (actedOn.has(key)) continue;
      actedOn.add(key);
      findings.push(finding);

      // A warn cannot refuse an action or end the turn, but it can still
      // correct the agent — and steering is the only way anything below a
      // violation reaches the agent at all. The reflection layer is entirely
      // warn-only by design, so without this its steer text is written, stored
      // and never delivered: the guard notices the repeat and says nothing.
      //
      // Honouring `steer` on its own merit is also what checks.ts already
      // documents ("leave it unset to record the finding without intervening"),
      // rather than gating on severity as this did before.
      if (finding.severity !== "violation") {
        if (enforce && finding.steer !== undefined) sendSteerWithinBudget(finding.steer);
        continue;
      }

      intervened = true;
      if (!enforce) continue;
      if (onViolation === "interrupt") {
        sendInterrupt();
      } else if (finding.steer !== undefined) {
        sendSteerWithinBudget(finding.steer);
      }
    }
    return found;
  }

  function recordIntentResult(result: IntentControllerResult): void {
    if (result.finding !== undefined) findings.push(result.finding);
    if (result.decision === "steer" && result.steer !== undefined) {
      intervened = true;
      sendSteer(result.steer);
    }
  }

  function queueReasoningReview(seq: number, cheapIntentSignal: boolean): void {
    if (intentController === undefined) return;
    const traceAtCheckpoint = [...records];
    semanticQueue = semanticQueue.then(async () => {
      const result = await intentController.observeReasoning(
        traceAtCheckpoint,
        seq,
        cheapIntentSignal,
      );
      recordIntentResult(result);
    });
  }

  function sendSteer(text: string): void {
    if (liveThreadId === null || turnId === null) return;
    void rpc
      .request("turn/steer", {
        threadId: liveThreadId,
        input: [{ type: "text", text }],
        expectedTurnId: turnId,
      })
      .catch(() => {
        // A turn that finished before the correction landed is not worth
        // failing the run over.
      });
  }

  /** End the turn now. Codex kills the running command and emits turn/completed. */
  function sendInterrupt(): void {
    if (interruptSent || liveThreadId === null || turnId === null) return;
    interruptSent = true;
    void rpc
      .request("turn/interrupt", { threadId: liveThreadId, turnId: turnId })
      .catch(() => {
        // Already ending: nothing to do.
      });
  }

  /**
   * Answer a permission request. With no checks this is the old behaviour:
   * accept everything. With checks, a pending command that trips a violation is
   * refused with `decline`, which drops that one action and lets the agent
   * carry on with the rest of the task (see codex-protocol.ts).
   */
  function deterministicViolationForApproval(
    params: Record<string, unknown>,
  ): Finding | undefined {
    if (checks.length === 0) return undefined;
    const pending = pendingCommandRecord(params, records);
    const trace = pending === null ? records : [...records, pending];
    return review(trace, false).find(
      (finding) => finding.severity === "violation",
    );
  }

  function markApprovalGate(params: Record<string, unknown>): void {
    const itemId = typeof params.itemId === "string" ? params.itemId : null;
    if (semanticEnforcement && itemId !== null) approvalGates.add(itemId);
  }

  function decideWithoutSemantic(params: Record<string, unknown>, id: number | string): void {
    const violation = deterministicViolationForApproval(params);
    if (violation === undefined) {
      rpc.reply(id, { decision: "accept" });
      return;
    }
    intervened = true;
    rpc.reply(id, { decision: "decline" });
  }

  async function decideWithSemantic(
    kind: "command" | "file_change",
    params: Record<string, unknown>,
    id: number | string,
  ): Promise<void> {
    // Ensure a reasoning item immediately before this request has influenced
    // the risk state before the action is approved.
    await semanticQueue;

    const violation = deterministicViolationForApproval(params);
    if (violation !== undefined) {
      intervened = true;
      rpc.reply(id, { decision: "decline" });
      return;
    }

    const action = proposedActionOf(kind, params, records);
    if (action === null || intentController === undefined) {
      rpc.reply(id, { decision: "accept" });
      return;
    }

    const traceAtCheckpoint = [...records];
    const reviewAndApply = semanticQueue.then(async () => {
      const result = await intentController.reviewAction(traceAtCheckpoint, action);
      if (result.finding !== undefined) findings.push(result.finding);
      if (result.decision === "allow" || result.decision === "steer") {
        rpc.reply(id, { decision: "accept" });
        if (result.decision === "steer" && result.steer !== undefined) {
          intervened = true;
          sendSteer(result.steer);
        }
        return;
      }

      // Refuse the concrete action first. The correction then tells Codex how
      // to continue instead of retrying the objective through another tool.
      intervened = true;
      rpc.reply(id, { decision: "decline" });
      if (result.decision === "interrupt") {
        sendInterrupt();
      } else if (result.steer !== undefined) {
        sendSteer(result.steer);
      }
    });
    semanticQueue = reviewAndApply;
    await reviewAndApply;
  }

  function commandApproval(
    params: Record<string, unknown>,
    id: number | string,
  ): void | Promise<void> {
    // This request is the real pre-execution barrier. The Runtime waits for
    // our reply, unlike an item/started or item/completed notification.
    markApprovalGate(params);
    return intentController === undefined
      ? decideWithoutSemantic(params, id)
      : decideWithSemantic("command", params, id);
  }

  function fileChangeApproval(
    params: Record<string, unknown>,
    id: number | string,
  ): void | Promise<void> {
    // File changes are explicitly paused at this request under semantic
    // enforcement, even though their item/started notification comes first.
    markApprovalGate(params);
    return intentController === undefined
      ? decideWithoutSemantic(params, id)
      : decideWithSemantic("file_change", params, id);
  }

  rpc.onRequest("item/commandExecution/requestApproval", commandApproval);
  rpc.onRequest("item/fileChange/requestApproval", fileChangeApproval);

  // Review the moment a command is announced, before it has finished, so an
  // interrupt has a chance to land before the command completes.
  rpc.on("item/started", function reviewOnStart() {
    review(records, true);
  });

  rpc.on("item/completed", function collectAgentMessage(params) {
    // Backstop: catch anything only visible once the action completed.
    const deterministic = review(records, true);

    const item = params.item as Record<string, unknown> | undefined;
    if (item === undefined) return;
    if (semanticEnforcement && item.type === "fileChange") {
      const itemId = typeof item.id === "string" ? item.id : null;
      if (itemId !== null && !approvalGates.has(itemId)) {
        // This does not claim to undo an already-completed mutation. It makes
        // a broken Runtime/protocol assumption visible and stops the turn
        // before it can perform more work.
        findings.push({
          check: "semantic-enforcement",
          code: "ungated-file-change",
          severity: "violation",
          seq: latestItemSeq(records, item),
          evidence: [latestItemSeq(records, item)],
          message:
            "Semantic enforcement expected this file change to wait for item/fileChange/requestApproval, but it completed without that gate. The turn was interrupted; any completed change requires audit or rollback.",
          metadata: { checkpoint: "file_change", controllerDecision: "interrupt" },
        });
        intervened = true;
        sendInterrupt();
      }
    }
    if (item.type === "reasoning") {
      const seq = latestItemSeq(records, item);
      const cheapIntentSignal = deterministic.some(
        (finding) => finding.check === "agent-intent" && finding.seq === seq,
      );
      queueReasoningReview(seq, cheapIntentSignal);
      return;
    }
    if (item.type !== "agentMessage") return;
    if (typeof item.text !== "string") return;
    messages.push(item.text);
  });

  rpc.on("thread/tokenUsage/updated", function collectUsage(params) {
    usage = readUsage(params);
  });

  // Without this, an upstream failure surfaces as the unhelpful
  // "completed without an agent message".
  rpc.on("error", function collectError(params) {
    const detail = params.error as { message?: string } | undefined;
    if (detail?.message !== undefined) {
      turnFailure = detail.message;
    }
  });

  const turnFinished = new Promise<Record<string, unknown>>(function waitForTurn(resolve) {
    rpc.on("turn/completed", resolve);
  });

  // --- protocol ---
  await rpc.request("initialize", {
    clientInfo: { name: "agents_on_a_leash", title: "Agents on a Leash", version: "0.1.0" },
  });
  rpc.notify("initialized", {});

  const threadId = await openThread(rpc, options);
  liveThreadId = threadId;

  const startedTurn = (await rpc.request("turn/start", {
    threadId: threadId,
    input: [{ type: "text", text: options.prompt }],
    sandboxPolicy: buildSandboxPolicy(options.sandboxMode, options.denyNetwork ?? false),
    ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
  })) as { turn?: { id?: string } };
  // turn/steer refuses to act on anything but the currently live turn.
  turnId = startedTurn?.turn?.id ?? null;

  const finalTurn = await turnFinished;
  // Preserve assessments in the outcome even if the model completed its final
  // message while the last reasoning review was still in flight.
  await semanticQueue;

  const failureFromTurn = readTurnError(finalTurn);
  if (failureFromTurn !== null) {
    turnFailure = failureFromTurn;
  }
  // An interrupt we sent ends the turn with an error too. That is the guard
  // working, not a failure, so report the findings instead of throwing.
  if (turnFailure !== null && !interruptSent) {
    throw new Error("Codex turn failed: " + turnFailure);
  }

  const lastMessage = messages.at(-1);
  const output =
    lastMessage !== undefined
      ? lastMessage.trim()
      : interruptSent
        ? "Run stopped by the guard before completion."
        : "";
  return {
    output: output,
    threadId: threadId,
    usage: usage,
    findings: findings,
    intervened: intervened,
  };
}

/**
 * A trace record for a command still waiting on approval, so the checks can
 * judge it before it runs. Returns null when the command is already in the
 * trace (its own `item/started` arrived first), so we do not double-count it.
 */
function pendingCommandRecord(
  params: Record<string, unknown>,
  records: TraceRecord[],
): TraceRecord | null {
  const itemId = typeof params.itemId === "string" ? params.itemId : null;
  const command = typeof params.command === "string" ? params.command : null;
  if (command === null) return null;
  if (
    itemId !== null &&
    records.some((record) => readItemId(record) === itemId)
  ) {
    return null;
  }
  return {
    seq: records.length + 1,
    at: new Date().toISOString(),
    dir: "in",
    method: "item/started",
    payload: {
      params: {
        item: {
          id: itemId ?? "",
          type: "commandExecution",
          command: command,
          cwd: typeof params.cwd === "string" ? params.cwd : null,
          commandActions: Array.isArray(params.commandActions)
            ? params.commandActions
            : [],
        },
      },
    },
  };
}

function readItemId(record: TraceRecord): string | null {
  const payload = record.payload as Record<string, unknown> | null;
  const inner = payload?.params as Record<string, unknown> | undefined;
  const item = inner?.item as Record<string, unknown> | undefined;
  return typeof item?.id === "string" ? item.id : null;
}

function latestItemSeq(records: TraceRecord[], item: Record<string, unknown>): number {
  const itemId = typeof item.id === "string" ? item.id : null;
  if (itemId !== null) {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (record !== undefined && readItemId(record) === itemId) return record.seq;
    }
  }
  return records.at(-1)?.seq ?? 0;
}

function proposedActionOf(
  kind: "command" | "file_change",
  params: Record<string, unknown>,
  records: TraceRecord[],
): SemanticProposedAction | null {
  const itemId = typeof params.itemId === "string" ? params.itemId : "";
  if (kind === "command") {
    const existing = commandsOf(records)
      .filter((entry) => itemId === "" || entry.itemId === itemId)
      .at(-1);
    const command =
      typeof params.command === "string" ? params.command : existing?.command;
    if ((command === undefined || command === "") && itemId === "") return null;
    return {
      type: "command",
      seq: existing?.seq ?? records.length + 1,
      itemId,
      command: command ?? "",
    };
  }

  const matching = fileChangesOf(records).filter(
    (entry) => itemId === "" || entry.itemId === itemId,
  );
  if (matching.length === 0) {
    return {
      type: "file_change",
      seq: records.at(-1)?.seq ?? records.length + 1,
      itemId,
      changes: [],
    };
  }
  const latestSeq = matching.at(-1)?.seq ?? records.length + 1;
  const changes = matching
    .filter((entry) => entry.seq === latestSeq)
    .map((entry) => ({ path: entry.path, kind: entry.kind, diff: entry.diff }));
  return { type: "file_change", seq: latestSeq, itemId, changes };
}

/**
 * Start a new conversation, or continue an existing one.
 *
 * Note the two different sandbox spellings. thread/start takes a plain string
 * in kebab case ("workspace-write"). turn/start takes an object in camel case
 * ({ type: "workspaceWrite" }). They are different types on adjacent calls and
 * sending the wrong one fails at runtime.
 */
async function openThread(rpc: JsonRpcConnection, options: TurnOptions): Promise<string | null> {
  const method = options.threadId === null ? "thread/start" : "thread/resume";

  const params: Record<string, unknown> = {
    cwd: "/workspace",
    sandbox: options.sandboxMode,
    ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
  };
  if (options.threadId !== null) {
    params.threadId = options.threadId;
  }

  const response = (await rpc.request(method, params)) as { thread?: { id?: string } };
  const id = response?.thread?.id;
  if (typeof id === "string") return id;
  return options.threadId;
}

/**
 * @param denyNetwork when true, drop network access from the policy so any
 * command that needs the network escalates to a permission request the caller
 * can inspect. `danger-full-access` cannot express this and is left as is.
 */
function buildSandboxPolicy(
  mode: TurnOptions["sandboxMode"],
  denyNetwork: boolean,
): Record<string, unknown> {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "read-only") {
    return {
      type: "readOnly",
      access: { type: "fullAccess" },
      networkAccess: !denyNetwork,
    };
  }
  return {
    type: "workspaceWrite",
    writableRoots: ["/workspace"],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: !denyNetwork,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function readUsage(params: Record<string, unknown>): RunUsage | null {
  const totals = (params.usage ?? params) as Record<string, unknown>;
  const input = totals.inputTokens ?? totals.input_tokens;
  const output = totals.outputTokens ?? totals.output_tokens;

  if (typeof input !== "number" && typeof output !== "number") return null;

  const usage: RunUsage = {};
  if (typeof input === "number") usage.inputTokens = input;
  if (typeof output === "number") usage.outputTokens = output;
  return usage;
}

function readTurnError(finalTurn: Record<string, unknown>): string | null {
  const turn = finalTurn.turn as Record<string, unknown> | undefined;
  if (turn === undefined) return null;

  const error = turn.error as { message?: string } | undefined;
  if (error?.message !== undefined) return error.message;
  return null;
}
