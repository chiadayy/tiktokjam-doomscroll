import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { workspaceScopeCheck } from "./check-workspace-scope.js";
import { JsonRpcConnection } from "./codex-app-server-client.js";
import { runTurn } from "./run-turn.js";
import type { TraceRecord } from "./trace.js";

/**
 * A stand-in for `codex app-server`, driven over two in-memory streams.
 *
 * It answers our protocol requests so a turn can proceed, and lets a test
 * script exactly what the agent does. No Docker, no model, no network.
 */
class FakeAgent {
  readonly toClient = new PassThrough();
  readonly fromClient = new PassThrough();
  readonly sent: Array<Record<string, unknown>> = [];
  private buffer = "";

  constructor() {
    this.fromClient.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() === "") continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        this.sent.push(message);
        this.autoReply(message);
      }
    });
  }

  private autoReply(message: Record<string, unknown>): void {
    const id = message.id;
    if (message.method === "initialize") this.respond(id, {});
    if (message.method === "thread/start") this.respond(id, { thread: { id: "thr_1" } });
    if (message.method === "turn/start") this.respond(id, { turn: { id: "turn_1" } });
    if (message.method === "turn/steer") this.respond(id, { turnId: "turn_1" });
  }

  private write(message: Record<string, unknown>): void {
    this.toClient.write(JSON.stringify(message) + "\n");
  }

  respond(id: unknown, result: unknown): void {
    this.write({ id, result });
  }

  /** Pretend the agent finished changing a file. */
  changedFile(itemId: string, path: string): void {
    this.write({
      method: "item/completed",
      params: {
        item: {
          id: itemId,
          type: "fileChange",
          changes: [{ path, kind: { type: "add" }, diff: "" }],
          status: "completed",
        },
      },
    });
  }

  replied(text: string): void {
    this.write({
      method: "item/completed",
      params: { item: { id: "msg_1", type: "agentMessage", text } },
    });
  }

  finished(): void {
    this.write({ method: "turn/completed", params: { turn: { id: "turn_1", status: "completed" } } });
  }

  /** Let queued stream events be processed. */
  settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 15));
  }

  steersSent(): string[] {
    return this.sent
      .filter((message) => message.method === "turn/steer")
      .map((message) => {
        const params = message.params as { input: Array<{ text: string }> };
        return params.input[0]?.text ?? "";
      });
  }
}

/** Wire the fake agent to a real connection, recording the trace as we go. */
function connect(agent: FakeAgent): { rpc: JsonRpcConnection; trace: TraceRecord[] } {
  const trace: TraceRecord[] = [];
  let seq = 0;

  const rpc = new JsonRpcConnection(
    { stdin: agent.fromClient, stdout: agent.toClient },
    (dir, message) => {
      seq += 1;
      const method = (message as { method?: string }).method ?? null;
      trace.push({ seq, at: new Date().toISOString(), dir, method, payload: message });
    },
  );

  return { rpc, trace };
}

const onlySrc = workspaceScopeCheck({ allowedPrefixes: ["/workspace/src/"] });

describe("an intervention, end to end", () => {
  it("corrects the agent mid-run when it writes outside its scope", async () => {
    const agent = new FakeAgent();
    const { rpc, trace } = connect(agent);

    const turn = runTurn({
      rpc,
      prompt: "tidy up the project",
      threadId: null,
      sandboxMode: "workspace-write",
      checks: [onlySrc],
      trace,
    });

    await agent.settle();

    // In scope. Nothing should happen.
    agent.changedFile("f1", "/workspace/src/app.ts");
    await agent.settle();
    expect(agent.steersSent()).toEqual([]);

    // Out of scope. This is the moment the middleware should act.
    agent.changedFile("f2", "/workspace/secrets/keys.txt");
    await agent.settle();

    const steers = agent.steersSent();
    expect(steers).toHaveLength(1);
    // The correction has to name the offending path and the allowed scope. An
    // agent told only "no" tends to retry the same thing.
    expect(steers[0]).toContain("/workspace/secrets/keys.txt");
    expect(steers[0]).toContain("/workspace/src/");

    agent.replied("done");
    agent.finished();

    const outcome = await turn;
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]).toMatchObject({
      check: "workspace-scope",
      code: "write-outside-scope",
      severity: "violation",
    });
  });

  it("corrects once per violation, not once per review", async () => {
    // Checks re-run over the whole trace after every action, so the same
    // finding is seen again and again. Acting each time would spam the agent.
    const agent = new FakeAgent();
    const { rpc, trace } = connect(agent);

    const turn = runTurn({
      rpc,
      prompt: "tidy up",
      threadId: null,
      sandboxMode: "workspace-write",
      checks: [onlySrc],
      trace,
    });
    await agent.settle();

    agent.changedFile("f1", "/workspace/nope.txt");
    await agent.settle();
    agent.changedFile("f2", "/workspace/src/fine.ts");
    await agent.settle();
    agent.changedFile("f3", "/workspace/src/also-fine.ts");
    await agent.settle();

    expect(agent.steersSent()).toHaveLength(1);

    agent.replied("done");
    agent.finished();
    await turn;
  });

  it("stays completely silent when no check is configured", async () => {
    // The default. Observation must not change what the agent does.
    const agent = new FakeAgent();
    const { rpc, trace } = connect(agent);

    const turn = runTurn({
      rpc,
      prompt: "tidy up",
      threadId: null,
      sandboxMode: "workspace-write",
      trace,
    });
    await agent.settle();

    agent.changedFile("f1", "/workspace/anywhere.txt");
    await agent.settle();
    agent.replied("done");
    agent.finished();

    const outcome = await turn;
    expect(agent.steersSent()).toEqual([]);
    expect(outcome.findings).toEqual([]);
  });
});
