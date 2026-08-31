// Drives one turn of an agent and records everything it does.
//
// With neither `checks` nor an `intentController` it decides nothing: every
// permission request is accepted, no action is refused, no correction is sent,
// and the agent runs exactly as it would if nobody were watching. That remains
// the default.
//
// When `checks` are passed it becomes the enforcement point. After each
// recorded action the checks run over the trace so far. Warnings may steer;
// definite violations at an approval boundary decline that action and send one
// standardized correction. A second distinct blocked action interrupts. An
// optional task-aware controller reviews only meaningful semantic checkpoints.
// This file remains the sole place that carries either verdict onto the wire.

import type { JsonRpcConnection } from "./codex-app-server-client.js";
import type { AskForApproval } from "./codex-protocol.js";
import {
  commandsOf,
  fileChangesOf,
  runChecks,
  type Check,
  type Finding,
} from "./checks.js";
import {
  isHighConsequenceCommand,
  type IntentController,
  type IntentControllerResult,
} from "./intent-controller.js";
import { redactSensitiveText } from "./redaction/index.js";
import type { SemanticProposedAction } from "./semantic-intent-monitor.js";
import {
  remediationForFinding,
  humanDecisionSteeringPrompt,
  steeringPrompt,
  type RemediationCategory,
} from "./steering-policy.js";
import type { TraceRecord } from "./trace.js";
import type {
  HumanApprovalDraft,
  HumanApprovalHandler,
  HumanApprovalReason,
  HumanApprovalResolution,
  RunUsage,
} from "./types.js";

/**
 * Most soft warning corrections one turn may receive from deterministic checks.
 *
 * Small on purpose. A steer is not a log line — it is text pushed into the
 * conversation the Agent is mid-way through, so several in a row stop reading
 * as a correction and start reading as a new task. The single recovery steer
 * after the first blocked action is reserved separately from this budget.
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
   * Legacy response when a check returns a `violation` and no verified effect
   * gate is active:
   *   "interrupt"  end the turn at once with `turn/interrupt`. The default.
   *   "steer-only" inject the correction text and let the turn continue.
   * A command still waiting on approval is always refused with `decline` and
   * receives the shared action-block correction regardless of this option.
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
  /** The Runtime is expected to approval-gate writes and external effects. */
  effectGating?: boolean;
  /** Optional one-shot delegation to the control plane. */
  requestHumanApproval?: HumanApprovalHandler;
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
  const effectGating = options.effectGating ?? semanticEnforcement;
  const requestHumanApproval = options.requestHumanApproval;

  // Collected as notifications arrive.
  const messages: string[] = [];
  let usage: RunUsage | null = null;
  let turnFailure: string | null = null;

  // Findings the checks have produced, and the action-specific keys already recorded.
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
  // Deterministic and semantic blocks share this set. Stable item IDs prevent
  // multiple findings for one action from counting as multiple attempts.
  const blockedActions = new Set<string>();
  // A user denial is not a safety strike. Exact retries are declined quietly
  // without creating another prompt or touching blockedActions.
  const humanDeniedActions = new Set<string>();

  const keyOf = (finding: Finding, trace: TraceRecord[]): string => {
    const action = actionIdentityAt(finding.seq, trace);
    return `${finding.check}:${finding.code}:${action}`;
  };

  // Every soft steer is text injected into the live turn, so it costs tokens
  // and competes with the task for attention. Warns are keyed per record — an
  // Agent that reads four watched files produces four of them. Cap those soft
  // corrections without consuming the separately reserved recovery steer.
  // Findings past the soft cap are still recorded; only delivery stops.
  let softSteersSent = 0;

  function sendSoftSteerWithinBudget(text: string): void {
    if (softSteersSent >= MAX_STEERS_PER_TURN) return;
    softSteersSent += 1;
    sendSteer(text);
  }

  /**
   * Run the checks over `trace` and act on anything new.
   *
   * @param enforceViolations when true, a violation triggers the legacy
   *   ungated response. Warnings that explicitly request steering are always
   *   eligible for the bounded shared correction.
   */
  function review(trace: TraceRecord[], enforceViolations: boolean): Finding[] {
    if (checks.length === 0) return [];
    const found = runChecks(checks, trace);
    for (const finding of found) {
      const key = keyOf(finding, trace);
      if (actedOn.has(key)) continue;
      actedOn.add(key);
      findings.push(finding);

      // A warn cannot refuse an action or end the turn, but it can still
      // correct the agent — and steering is the only way anything below a
      // violation reaches the agent at all. The reflection layer is entirely
      // warn-only by design, so without this the guard notices the repeat and
      // says nothing. The detector requests correction; the shared policy owns
      // the actual text.
      if (finding.severity !== "violation") {
        const category = remediationForFinding(finding);
        if ((finding.requestSteer === true || finding.steer !== undefined) && category !== null) {
          sendSoftSteerWithinBudget(
            steeringPrompt(options.prompt, category, false, finding.steerStrength),
          );
        }
        continue;
      }

      if (!enforceViolations) continue;
      intervened = true;
      if (onViolation === "interrupt") {
        sendInterrupt();
      } else {
        const category = remediationForFinding(finding);
        if (category !== null) {
          sendSoftSteerWithinBudget(steeringPrompt(options.prompt, category, false));
        }
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
  function deterministicFindingsForApproval(
    kind: "command" | "file_change",
    params: Record<string, unknown>,
  ): Finding[] {
    if (checks.length === 0) return [];
    const pending = kind === "command" ? pendingCommandRecord(params, records) : null;
    const trace = pending === null ? records : [...records, pending];
    review(trace, false);
    const actionKey = approvalActionIdentity(kind, params, trace);
    return runChecks(checks, trace).filter(
      (finding) => actionIdentityAt(finding.seq, trace) === actionKey,
    );
  }

  function markApprovalGate(params: Record<string, unknown>): void {
    const itemId = typeof params.itemId === "string" ? params.itemId : null;
    if (effectGating && itemId !== null) approvalGates.add(itemId);
  }

  function blockAction(
    kind: "command" | "file_change",
    params: Record<string, unknown>,
    id: number | string,
    category: RemediationCategory,
    trustedSteer?: string,
  ): void {
    const actionKey = approvalActionIdentity(kind, params, records);
    const isNewAttempt = !blockedActions.has(actionKey);
    rpc.reply(id, { decision: "decline" });
    intervened = true;
    if (!isNewAttempt) return;

    const priorAttempts = blockedActions.size;
    blockedActions.add(actionKey);
    if (priorAttempts > 0) {
      sendInterrupt();
      return;
    }
    // Recovery has its own single-use allowance: the first distinct blocked
    // action always receives this correction, while the second interrupts.
    sendSteer(trustedSteer ?? steeringPrompt(options.prompt, category, true));
  }

  function decideWithoutSemantic(
    kind: "command" | "file_change",
    params: Record<string, unknown>,
    id: number | string,
  ): void | Promise<void> {
    const deterministic = deterministicFindingsForApproval(kind, params);
    const violation = deterministic.find((finding) => finding.severity === "violation");
    if (violation === undefined) return decidePermittedAction(kind, params, id);
    blockAction(
      kind,
      params,
      id,
      remediationForFinding(violation) ?? "scope_expansion",
    );
  }

  async function decideWithSemantic(
    kind: "command" | "file_change",
    params: Record<string, unknown>,
    id: number | string,
  ): Promise<void> {
    // Ensure a reasoning item immediately before this request has influenced
    // the risk state before the action is approved.
    await semanticQueue;

    const deterministic = deterministicFindingsForApproval(kind, params);
    const violation = deterministic.find((finding) => finding.severity === "violation");
    if (violation !== undefined) {
      blockAction(
        kind,
        params,
        id,
        remediationForFinding(violation) ?? "scope_expansion",
      );
      return;
    }

    const action = proposedActionOf(kind, params, records);
    if (action === null || intentController === undefined) {
      rpc.reply(id, { decision: "accept" });
      return;
    }

    const traceAtCheckpoint = [...records];
    const reviewAndApply = semanticQueue.then(async () => {
      const forceReview = deterministic.some(
        (finding) => finding.requestSemanticReview === true,
      );
      const result = await intentController.reviewAction(traceAtCheckpoint, action, forceReview);
      if (result.decision === "human_review") {
        if (requestHumanApproval === undefined) {
          if (result.finding !== undefined) {
            findings.push({
              ...result.finding,
              severity: "violation",
              metadata: {
                ...result.finding.metadata,
                controllerDecision: "decline",
                humanReviewUnavailable: true,
              },
            });
          }
          blockAction(kind, params, id, "scope_expansion", result.steer);
          return;
        }
        if (result.finding !== undefined) findings.push(result.finding);
        await decideWithHuman(
          kind,
          params,
          id,
          action,
          result.humanReviewReason ?? "semantic_uncertainty",
        );
        return;
      }
      if (result.finding !== undefined) findings.push(result.finding);
      if (result.decision === "allow" || result.decision === "steer") {
        if (result.decision === "steer" && result.steer !== undefined) {
          intervened = true;
          sendSteer(result.steer);
        }
        await decidePermittedAction(kind, params, id, action);
        return;
      }

      // Refuse the concrete action first. The correction then tells Codex how
      // to continue instead of retrying the objective through another tool.
      blockAction(kind, params, id, "scope_expansion", result.steer);
    });
    semanticQueue = reviewAndApply;
    await reviewAndApply;
  }

  function decidePermittedAction(
    kind: "command" | "file_change",
    params: Record<string, unknown>,
    id: number | string,
    knownAction?: SemanticProposedAction,
  ): void | Promise<void> {
    const action = knownAction ?? proposedActionOf(kind, params, records);
    if (
      requestHumanApproval === undefined ||
      action === null ||
      action.type !== "command" ||
      !isHighConsequenceCommand(action.command)
    ) {
      rpc.reply(id, { decision: "accept" });
      return;
    }
    return decideWithHuman(kind, params, id, action, "high_consequence");
  }

  async function decideWithHuman(
    kind: "command" | "file_change",
    params: Record<string, unknown>,
    id: number | string,
    action: SemanticProposedAction,
    reason: HumanApprovalReason,
  ): Promise<void> {
    if (requestHumanApproval === undefined) {
      rpc.reply(id, { decision: "accept" });
      return;
    }
    const actionKey = humanActionIdentity(action);
    if (humanDeniedActions.has(actionKey)) {
      rpc.reply(id, { decision: "decline" });
      findings.push(humanApprovalFinding("approval-denied-retry", reason, action, "denied"));
      return;
    }

    const request = humanApprovalDraft(reason, action);
    findings.push(humanApprovalFinding("approval-requested", reason, action, "requested"));
    let resolution: HumanApprovalResolution;
    try {
      resolution = await requestHumanApproval(request);
    } catch {
      // The service callback is part of the control boundary. If it fails,
      // never leave Codex paused and never turn that failure into permission.
      resolution = { decision: "deny", outcome: "cancelled" };
    }

    const code =
      resolution.outcome === "approved"
        ? "approval-approved"
        : resolution.outcome === "timed_out"
          ? "approval-timed-out"
          : resolution.outcome === "cancelled"
            ? "approval-cancelled"
            : "approval-denied";
    findings.push(humanApprovalFinding(code, reason, action, resolution.outcome));
    if (resolution.decision === "approve") {
      rpc.reply(id, { decision: "accept" });
      return;
    }

    rpc.reply(id, { decision: "decline" });
    intervened = true;
    humanDeniedActions.add(actionKey);
    if (resolution.outcome === "denied" || resolution.outcome === "timed_out") {
      sendSteer(humanDecisionSteeringPrompt(resolution.outcome));
    }
  }

  function commandApproval(
    params: Record<string, unknown>,
    id: number | string,
  ): void | Promise<void> {
    // This request is the real pre-execution barrier. The Runtime waits for
    // our reply, unlike an item/started or item/completed notification.
    markApprovalGate(params);
    return intentController === undefined
      ? decideWithoutSemantic("command", params, id)
      : decideWithSemantic("command", params, id);
  }

  function fileChangeApproval(
    params: Record<string, unknown>,
    id: number | string,
  ): void | Promise<void> {
    // Effect-gated file changes pause here even though their item/started
    // notification comes first.
    markApprovalGate(params);
    return intentController === undefined
      ? decideWithoutSemantic("file_change", params, id)
      : decideWithSemantic("file_change", params, id);
  }

  rpc.onRequest("item/commandExecution/requestApproval", commandApproval);
  rpc.onRequest("item/fileChange/requestApproval", fileChangeApproval);

  // Under effect gating, item/started announces a proposal; the approval
  // request is the enforcement point. Without that boundary, retain the
  // legacy immediate response for a definitely unsafe running action.
  rpc.on("item/started", function reviewOnStart() {
    review(records, !effectGating);
  });

  rpc.on("item/completed", function collectAgentMessage(params) {
    // Backstop: catch anything only visible once the action completed.
    const deterministic = review(records, !effectGating);

    const item = params.item as Record<string, unknown> | undefined;
    if (item === undefined) return;
    if (effectGating && item.type === "fileChange") {
      const itemId = typeof item.id === "string" ? item.id : null;
      if (itemId !== null && !approvalGates.has(itemId)) {
        // This does not claim to undo an already-completed mutation. It makes
        // a broken Runtime/protocol assumption visible and stops the turn
        // before it can perform more work.
        findings.push({
          check: "runtime-enforcement",
          code: "ungated-file-change",
          severity: "violation",
          seq: latestItemSeq(records, item),
          evidence: [latestItemSeq(records, item)],
          message:
            "Effect gating expected this file change to wait for item/fileChange/requestApproval, but it completed without that gate. The turn was interrupted; the completed change was not rolled back.",
          metadata: { checkpoint: "file_change", controllerDecision: "interrupt" },
        });
        intervened = true;
        sendInterrupt();
      }
    }
    if (effectGating && item.type === "commandExecution") {
      const itemId = typeof item.id === "string" ? item.id : null;
      const seq = latestItemSeq(records, item);
      const unsafe = runChecks(checks, records).some(
        (finding) =>
          finding.severity === "violation" &&
          actionIdentityAt(finding.seq, records) === actionIdentity(itemId, seq),
      );
      if (unsafe && itemId !== null && !approvalGates.has(itemId)) {
        const completed = commandsOf(records)
          .filter((command) => command.itemId === itemId && command.phase === "completed")
          .at(-1);
        const commandNotFoundObserved =
          /\b(?:command not found|not recognized as an internal or external command)\b/i.test(
            completed?.output ?? "",
          );
        findings.push({
          check: "runtime-enforcement",
          code: "ungated-command",
          severity: "violation",
          seq,
          evidence: [seq],
          message:
            "Effect gating expected this unsafe command to wait for item/commandExecution/requestApproval, but the command completed without that gate. The turn was interrupted because the pre-execution enforcement boundary was not observed. Whether the protected external effect actually occurred cannot be established from this event, and no rollback is claimed.",
          metadata: {
            checkpoint: "command",
            controllerDecision: "interrupt",
            exitCode: completed?.exitCode ?? null,
            commandNotFoundObserved,
            protectedEffect: "unknown",
          },
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

function actionIdentity(itemId: string | null, seq: number): string {
  return itemId === null || itemId === "" ? `seq:${seq}` : `item:${itemId}`;
}

function actionIdentityAt(seq: number, records: TraceRecord[]): string {
  const record = records.find((entry) => entry.seq === seq);
  return actionIdentity(record === undefined ? null : readItemId(record), seq);
}

function approvalActionIdentity(
  kind: "command" | "file_change",
  params: Record<string, unknown>,
  records: TraceRecord[],
): string {
  const itemId = typeof params.itemId === "string" ? params.itemId : null;
  if (itemId !== null && itemId !== "") return actionIdentity(itemId, 0);
  const action = proposedActionOf(kind, params, records);
  return actionIdentity(null, action?.seq ?? records.length + 1);
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

function humanActionIdentity(action: SemanticProposedAction): string {
  if (action.type === "command") {
    return `command:${action.command.replace(/\s+/g, " ").trim()}`;
  }
  return `file_change:${JSON.stringify(action.changes)}`;
}

function humanApprovalDraft(
  reason: HumanApprovalReason,
  action: SemanticProposedAction,
): HumanApprovalDraft {
  if (action.type === "command") {
    const command = boundedSafeText(action.command, 1_200);
    return {
      reason,
      actionType: "command",
      actionId: action.itemId || `seq:${action.seq}`,
      summary: boundedSafeText(`Run: ${action.command.replace(/\s+/g, " ").trim()}`, 240),
      safeDetails: command,
    };
  }

  const paths = action.changes.map((change) => change.path).filter(Boolean);
  const target = paths.length === 0 ? "workspace files" : paths.slice(0, 3).join(", ");
  const details = action.changes
    .slice(0, 4)
    .map((change) => `${change.kind} ${change.path}\n${change.diff}`)
    .join("\n\n");
  return {
    reason,
    actionType: "file_change",
    actionId: action.itemId || `seq:${action.seq}`,
    summary: boundedSafeText(`Modify ${target}`, 240),
    ...(details === "" ? {} : { safeDetails: boundedSafeText(details, 2_000) }),
  };
}

function boundedSafeText(text: string, maximum: number): string {
  const safe = redactSensitiveText(text).replace(/\0/g, "").trim();
  return safe.length <= maximum ? safe : safe.slice(0, maximum - 1) + "…";
}

function humanApprovalFinding(
  code: string,
  reason: HumanApprovalReason,
  action: SemanticProposedAction,
  outcome: "requested" | HumanApprovalResolution["outcome"],
): Finding {
  const messages: Record<typeof outcome, string> = {
    requested: "A one-shot human decision was requested for this action.",
    approved: "The user approved this specific action once.",
    denied: "The user denied this action.",
    timed_out: "Human approval timed out, so the action was denied.",
    cancelled: "The pending human approval was cancelled with the run.",
  };
  return {
    check: "human-approval",
    code,
    severity: "info",
    seq: action.seq,
    evidence: [action.seq],
    message: messages[outcome],
    metadata: {
      reason,
      actionType: action.type,
      actionId: action.itemId || `seq:${action.seq}`,
      outcome,
    },
  };
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
