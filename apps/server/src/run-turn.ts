// Drives one turn of an agent and records everything it does.
//
// This file deliberately does NOT decide anything. Every permission request is
// accepted, no action is refused, no correction is sent. The agent runs exactly
// as it would if nobody were watching, and the full raw exchange is written to
// the run's trace file.
//
// The ability to refuse or redirect is already wired up and proven: the runtime
// pauses for permission and accepts new instructions mid turn. We are choosing
// not to use it yet, so that the traces we collect show unimpeded behaviour.
// Enforcement belongs on top of this, driven by the checks in checks.ts.

import type { JsonRpcConnection } from "./codex-app-server-client.js";
import { runChecks, type Check, type Finding } from "./checks.js";
import type { TraceRecord } from "./trace.js";
import type { RunUsage } from "./types.js";

export interface TurnOptions {
  rpc: JsonRpcConnection;
  prompt: string;
  /** Null starts a new conversation; a value continues an existing one. */
  threadId: string | null;
  /** Mirrors CODEX_SANDBOX_MODE. */
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  /**
   * Checks to run as the trace grows. Leave empty to observe without
   * intervening, which is the default.
   */
  checks?: Check[];
  /**
   * The run's trace, growing as messages arrive. Checks read this. The caller
   * owns it so the same records can also be written to disk.
   */
  trace?: TraceRecord[];
}

export interface TurnOutcome {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
  /** Everything the checks reported, in the order they were found. */
  findings: Finding[];
}

export async function runTurn(options: TurnOptions): Promise<TurnOutcome> {
  const rpc = options.rpc;

  // Collected as notifications arrive.
  const messages: string[] = [];
  let usage: RunUsage | null = null;
  let turnFailure: string | null = null;

  const checks = options.checks ?? [];
  const trace = options.trace ?? [];
  const found: Finding[] = [];
  /** Findings already acted on, so one violation corrects the agent once. */
  const actedOn = new Set<string>();
  let threadIdForSteer: string | null = options.threadId;
  let turnId: string | null = null;

  /**
   * Run every check over the trace so far and correct the agent for anything
   * new. Called after each recorded action, so a correction lands while the
   * agent is still working rather than after it has finished.
   */
  async function review(): Promise<void> {
    if (checks.length === 0) return;

    for (const finding of runChecks(checks, trace)) {
      const key = `${finding.check}:${finding.code}:${finding.seq}`;
      if (actedOn.has(key)) continue;
      actedOn.add(key);
      found.push(finding);

      if (finding.steer !== undefined) {
        await steer(finding.steer);
      }
    }
  }

  async function steer(text: string): Promise<void> {
    if (threadIdForSteer === null || turnId === null) return;
    try {
      await rpc.request("turn/steer", {
        threadId: threadIdForSteer,
        input: [{ type: "text", text }],
        expectedTurnId: turnId,
      });
    } catch {
      // A turn that ended before the correction landed is not worth failing on.
    }
  }

  // Accept every permission request, immediately. The runtime blocks until we
  // answer, so not answering would change the agent's behaviour, which is the
  // one thing this file must not do.
  function acceptApproval(_params: Record<string, unknown>, id: number | string): void {
    rpc.reply(id, { decision: "accept" });
  }

  rpc.onRequest("item/commandExecution/requestApproval", acceptApproval);
  rpc.onRequest("item/fileChange/requestApproval", acceptApproval);

  rpc.on("item/completed", function collectAgentMessage(params) {
    const item = params.item as Record<string, unknown> | undefined;
    if (item === undefined) return;

    // Review after every completed action, so a correction is sent while there
    // is still a turn to correct.
    void review();

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
  threadIdForSteer = threadId;

  const startedTurn = (await rpc.request("turn/start", {
    threadId: threadId,
    input: [{ type: "text", text: options.prompt }],
    sandboxPolicy: buildSandboxPolicy(options.sandboxMode),
  })) as { turn?: { id?: string } };
  // Needed for turn/steer, which refuses to act on anything but the live turn.
  turnId = startedTurn?.turn?.id ?? null;

  const finalTurn = await turnFinished;

  const failureFromTurn = readTurnError(finalTurn);
  if (failureFromTurn !== null) {
    turnFailure = failureFromTurn;
  }
  if (turnFailure !== null) {
    throw new Error("Codex turn failed: " + turnFailure);
  }

  const lastMessage = messages.at(-1);
  return {
    output: lastMessage === undefined ? "" : lastMessage.trim(),
    threadId: threadId,
    usage: usage,
    findings: found,
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
  };
  if (options.threadId !== null) {
    params.threadId = options.threadId;
  }

  const response = (await rpc.request(method, params)) as { thread?: { id?: string } };
  const id = response?.thread?.id;
  if (typeof id === "string") return id;
  return options.threadId;
}

function buildSandboxPolicy(mode: TurnOptions["sandboxMode"]): Record<string, unknown> {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "read-only") {
    return {
      type: "readOnly",
      access: { type: "fullAccess" },
      networkAccess: true,
    };
  }
  return {
    type: "workspaceWrite",
    writableRoots: ["/workspace"],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: true,
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
