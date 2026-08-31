// LIVE driver: drive the real stack (disposable container + Codex + model) once
// per (scenario, guardConfig, trial), record the trace, and score it. This is
// the AgentDojo analogue and the only path that spends API tokens.
//
// It reproduces the wiring from apps/server/src/index.ts (ark proxy +
// writeCodexConfig) and then calls ContainerCodexRunner directly — the same
// call AgentService.executeRun makes — so no HTTP server is involved.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, rmSync, appendFileSync } from "node:fs";
import path from "node:path";
import { startArkProxy, type ArkProxy } from "../apps/server/src/ark-proxy.js";
import { loadConfig, writeCodexConfig, type AppConfig } from "../apps/server/src/config.js";
import { ContainerCodexRunner } from "../apps/server/src/container-codex-runner.js";
import { traceOf } from "../apps/server/src/errors.js";
import type { Reflection } from "../apps/server/src/reflections.js";
import { traceFilePath } from "../apps/server/src/trace.js";
import { buildTrialResult } from "./metrics.js";
import { readTrace } from "./trace-io.js";
import type { GuardConfig, Scenario, ScoreContext, TrialResult } from "./types.js";

export interface LiveOptions {
  scenarios: Scenario[];
  guardConfigs: GuardConfig[];
  trials: number;
  outDir: string;
  /** Paired-group names to run reflection-threaded. */
  pairedGroups: string[];
  /** Ordered scenario ids per paired group. */
  pairedMembers: Record<string, string[]>;
  /** A directory the container engine can bind-mount (share with the VM). */
  workspaceRoot: string;
  /** Parent for the harness's APP_DATA_DIR / CODEX_HOME. */
  stateRoot: string;
  keepWorkspaces: boolean;
  onProgress?: (line: string) => void;
}

function baseEnv(stateRoot: string, workspaceRoot: string): Record<string, string> {
  const pass = (k: string) => (process.env[k] ? { [k]: process.env[k] as string } : {});
  return {
    NODE_ENV: "production",
    // Loopback so loadConfig does not demand a 24-char APP_AUTH_TOKEN; the
    // harness never starts an HTTP server anyway.
    HOST: "127.0.0.1",
    RUNTIME_PROVIDER: "container",
    APP_DATA_DIR: path.join(stateRoot, "data"),
    AGENT_WORKSPACE_ROOT: workspaceRoot,
    CODEX_HOME: path.join(stateRoot, "codex-home"),
    ...pass("MODEL_PROVIDER"),
    ...pass("ARK_API_KEY"),
    ...pass("ARK_MODEL"),
    ...pass("ARK_BASE_URL"),
    ...pass("OPENAI_API_KEY"),
    ...pass("OPENAI_MODEL"),
    ...pass("CONTAINER_ENGINE"),
    ...pass("CONTAINER_RUNTIME_IMAGE"),
    ...pass("CODEX_TIMEOUT_MS"),
    ...pass("GUARDRAIL_SENSITIVE_MARKERS"),
    ...pass("GUARDRAIL_BLOB_MIN_CHARS"),
    ...pass("GUARDRAIL_SEMANTIC_MODEL"),
    ...pass("RUNTIME_INSTANCE_ID"),
  };
}

export async function runLive(opts: LiveOptions): Promise<TrialResult[]> {
  const log = opts.onProgress ?? ((l: string) => console.error(l));
  mkdirSync(path.join(opts.outDir, "traces"), { recursive: true });
  mkdirSync(opts.workspaceRoot, { recursive: true });

  const results: TrialResult[] = [];
  const pairedSet = new Set(opts.pairedGroups);

  for (const gc of opts.guardConfigs) {
    const env = { ...baseEnv(opts.stateRoot, opts.workspaceRoot), ...gc.env };
    const config = loadConfig(env as NodeJS.ProcessEnv);

    let arkProxy: ArkProxy | null = null;
    if (config.arkProxyEnabled) arkProxy = await startArkProxy(config);
    await writeCodexConfig(config, arkProxy?.baseUrlForCodex ?? config.arkBaseUrl);

    const runner = new ContainerCodexRunner(config);
    if (!(await runner.isAvailable())) {
      await arkProxy?.close();
      throw new Error(
        "Container runtime not available. Start Docker/Colima/Podman and build " +
          "the runtime image (see `npm run poc`), then retry.",
      );
    }

    log(`\n=== guard config: ${gc.name} ===`);

    // Non-paired scenarios.
    for (const scenario of opts.scenarios) {
      if (scenario.pair && pairedSet.has(scenario.pair.group)) continue;
      for (let trial = 0; trial < opts.trials; trial += 1) {
        const tr = await runOne({
          scenario,
          config,
          gcName: gc.name,
          runner,
          trial,
          outDir: opts.outDir,
          workspaceRoot: opts.workspaceRoot,
          keepWorkspaces: opts.keepWorkspaces,
          reflections: [],
          log,
        });
        results.push(tr.result);
      }
    }

    // Paired (reflection-threaded) groups.
    for (const group of opts.pairedGroups) {
      const members = (opts.pairedMembers[group] ?? [])
        .map((id) => opts.scenarios.find((s) => s.id === id))
        .filter((s): s is Scenario => s !== undefined);
      if (members.length === 0) continue;

      for (let trial = 0; trial < opts.trials; trial += 1) {
        let reflections: Reflection[] = [];
        for (let i = 0; i < members.length; i += 1) {
          const scenario = members[i]!;
          const tr = await runOne({
            scenario,
            config,
            gcName: gc.name,
            runner,
            trial,
            outDir: opts.outDir,
            workspaceRoot: opts.workspaceRoot,
            keepWorkspaces: opts.keepWorkspaces,
            reflections,
            threadRunIndex: i,
            log,
          });
          results.push(tr.result);
          reflections = tr.reflections; // carry forward; thread stays fresh (null)
        }
      }
    }

    await arkProxy?.close();
  }

  return results;
}

async function runOne(args: {
  scenario: Scenario;
  config: AppConfig;
  gcName: string;
  runner: ContainerCodexRunner;
  trial: number;
  outDir: string;
  workspaceRoot: string;
  keepWorkspaces: boolean;
  reflections: Reflection[];
  threadRunIndex?: number;
  log: (l: string) => void;
}): Promise<{ result: TrialResult; reflections: Reflection[] }> {
  const { scenario, config } = args;
  const runId = randomUUID();
  const agentId = `bench-${scenario.id}-${args.gcName}-${args.trial}-${runId.slice(0, 8)}`;
  const workspaceDir = path.join(args.workspaceRoot, agentId);
  mkdirSync(workspaceDir, { recursive: true });

  scenario.setupWorkspace(workspaceDir);
  scenario.attack?.place(workspaceDir);

  args.log(`  ${scenario.id} [${args.gcName}] trial ${args.trial} …`);

  let ctx: ScoreContext;
  let outReflections = args.reflections;
  let error: string | undefined;

  try {
    const result = await args.runner.run({
      agentId,
      workspacePath: workspaceDir,
      prompt: scenario.prompt,
      taskContext: { userPrompt: scenario.prompt, agentInstructions: "" },
      threadId: null,
      runId,
      reflections: args.reflections,
    });
    const tracePath = result.trace?.path ?? traceFilePath(config.dataDirectory, runId);
    const trace = readTrace(tracePath);
    ctx = {
      trace,
      workspaceDir,
      output: result.output,
      findings: result.findings ?? [],
      intervened: result.intervened ?? false,
    };
    outReflections = result.reflections ?? args.reflections;
    cpSync(tracePath, path.join(args.outDir, "traces", `${runId}.jsonl`));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    const rt = traceOf(err);
    const trace = rt ? safeReadTrace(rt.path) : [];
    ctx = { trace, workspaceDir, output: "", findings: [], intervened: false };
    args.log(`    ! ${error}`);
  }

  const result = buildTrialResult({
    scenario,
    guardConfig: args.gcName,
    trial: args.trial,
    ctx,
    ...(args.threadRunIndex !== undefined ? { threadRunIndex: args.threadRunIndex } : {}),
    ...(error !== undefined ? { error } : {}),
  });

  appendFileSync(
    path.join(args.outDir, "manifest.jsonl"),
    JSON.stringify({
      runId,
      scenarioId: scenario.id,
      guardConfig: args.gcName,
      trial: args.trial,
      threadRunIndex: args.threadRunIndex ?? null,
      userGoalAchieved: result.userGoalAchieved,
      attackExecuted: result.attackExecuted,
      traceFile: `traces/${runId}.jsonl`,
    }) + "\n",
  );

  if (!args.keepWorkspaces) {
    try {
      // .git can hold read-only objects; force through them.
      execFileSync("chmod", ["-R", "u+w", workspaceDir], { stdio: "ignore" });
    } catch {
      /* best effort */
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  }

  return { result, reflections: outReflections };
}

function safeReadTrace(file: string) {
  try {
    return readTrace(file);
  } catch {
    return [];
  }
}
