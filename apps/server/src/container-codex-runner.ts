import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { JsonRpcConnection } from "./codex-app-server-client.js";
import type { AppConfig } from "./config.js";
import { attachTrace, RunCancelledError } from "./errors.js";
import { runTurn } from "./run-turn.js";
import { TraceWriter, traceFilePath, type TraceRecord } from "./trace.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";

const execFileAsync = promisify(execFile);

interface ActiveContainer {
  child: ChildProcess;
  containerName: string;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  settled: Promise<void>;
  termination: Promise<void> | null;
}

export function containerName(agentId: string, instanceId = "default"): string {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return "launchpad-" + safeInstance + "-" + safeAgent;
}

export function buildContainerRunArgs(
  request: RunnerRequest,
  config: AppConfig,
): string[] {
  const name = containerName(request.agentId, config.runtimeInstanceId);
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  return [
    "run",
    "--rm",
    "--init",
    // app-server speaks JSON-RPC over stdio, so the container needs stdin.
    "--interactive",
    "--name",
    name,
    "--label",
    "io.codejam.launchpad=agent-runtime",
    "--label",
    "io.codejam.agent-id=" + request.agentId,
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    "bridge",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    "--env",
    // Whichever variable the selected provider reads its key from.
    config.modelApiKeyEnvName,
    "--env",
    "CODEX_HOME=/codex-home",
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--mount",
    "type=bind,src=" + request.workspacePath + ",dst=/workspace",
    "--mount",
    "type=bind,src=" + config.codexHome + ",dst=/codex-home",
    "--workdir",
    "/workspace",
    config.containerRuntimeImage,
    "codex",
    // NOT `exec`. That mode hardcodes approval_policy=Never and closes its own
    // stdin, so nothing can observe or interrupt it. `app-server` is the same
    // binary speaking bidirectional JSON-RPC, which is what makes both the
    // trace and any future enforcement possible.
    "app-server",
    "--listen",
    "stdio://",
  ];
}

export class ContainerCodexRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveContainer>();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.containerEngine, ["version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      await execFileAsync(
        this.config.containerEngine,
        ["image", "inspect", this.config.containerRuntimeImage],
        { timeout: 5_000, env: this.childEnvironment() },
      );
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) return false;

    active.cancelled = true;
    await this.removeContainer(active);
    await active.settled;
    return true;
  }

  private removeContainer(active: ActiveContainer): Promise<void> {
    if (!active.termination) {
      active.termination = execFileAsync(
        this.config.containerEngine,
        ["rm", "--force", active.containerName],
        { timeout: 8_000, env: this.childEnvironment() },
      )
        .then(() => undefined)
        .catch(() => {
          active.child.kill("SIGTERM");
          const forceKill = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
          forceKill.unref();
        });
    }
    return active.termination;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Runtime container");
    }

    const child = spawn(
      this.config.containerEngine,
      buildContainerRunArgs(request, this.config),
      {
        cwd: request.workspacePath,
        env: this.childEnvironment(),
        // stdin is a pipe now, because the protocol is two way.
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active: ActiveContainer = {
      child,
      containerName: containerName(request.agentId, this.config.runtimeInstanceId),
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      termination: null,
    };
    this.active.set(request.agentId, active);

    // Byte cap and stderr tail are the starter kit's original safety net. They
    // stay as a crash guard and should never fire during a normal run.
    let stderr = "";
    let totalBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        void this.removeContainer(active);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
    });

    // Every message in either direction is written to the run's trace file
    // before anything else looks at it. Tracing never blocks or alters the
    // exchange.
    const trace = new TraceWriter(
      traceFilePath(this.config.dataDirectory, request.runId ?? randomUUID()),
    );
    await trace.open();

    // The same messages go two places: to disk as the permanent record, and to
    // an in-memory list the checks read while the run is still going.
    const records: TraceRecord[] = [];
    let seq = 0;

    const rpc = new JsonRpcConnection(
      { stdin: child.stdin, stdout: child.stdout },
      (direction, message) => {
        trace.record(direction, message);
        seq += 1;
        records.push({
          seq,
          at: new Date().toISOString(),
          dir: direction,
          method: methodOf(message),
          payload: message,
        });
      },
    );
    // A container killed mid-turn must reject in-flight requests, or the turn
    // promise hangs until the process-level timeout instead of failing cleanly.
    child.once("close", () => rpc.fail(new Error("Runtime container exited")));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      void this.removeContainer(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const outcome = await runTurn({
        rpc: rpc,
        prompt: request.prompt,
        threadId: request.threadId,
        sandboxMode: this.config.codexSandboxMode,
        checks: request.checks ?? [],
        trace: records,
        lessons: request.lessons ?? [],
      });

      if (active.cancelled) throw new RunCancelledError();
      if (active.timedOut) {
        throw new Error("Runtime timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (!outcome.output) throw new Error("Codex completed without an agent message");
      return { ...outcome, trace: await trace.close() };
    } catch (error) {
      // The trace pointer travels out on the error too. A failed run is the one
      // you most want the evidence for.
      throw attachTrace(this.describeFailure(error, active, stderr), await trace.close());
    } finally {
      clearTimeout(timeout);
      void this.removeContainer(active);
      this.active.delete(request.agentId);
    }
  }

  /** Turn whatever went wrong into the clearest error we can. */
  private describeFailure(error: unknown, active: ActiveContainer, stderr: string): Error {
    if (active.cancelled) return new RunCancelledError();
    if (active.timedOut) {
      return new Error("Runtime timed out after " + this.config.codexTimeoutMs + " ms");
    }
    if (active.outputExceeded) {
      return new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
    }
    const detail = stderr.trim();
    if (detail === "") return new Error(String(error));
    return new Error(String(error) + " (stderr: " + detail + ")");
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      [this.config.modelApiKeyEnvName]: this.config.modelApiKey,
      NO_COLOR: "1",
    };
    for (const name of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
    ] as const) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}

/** Same rule the trace writer uses, so on-disk and in-memory records match. */
function methodOf(message: unknown): string | null {
  if (message === null || typeof message !== "object") return null;
  const method = (message as Record<string, unknown>).method;
  return typeof method === "string" ? method : null;
}
