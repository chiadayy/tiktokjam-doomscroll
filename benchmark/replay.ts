// REPLAY driver: re-score recorded traces under other guard configs, for free.
//
// A recorded run's trajectory is fixed, so task completion and whether the
// malicious action ran are carried from the original scoring (the manifest).
// What replay recomputes is the guard-derived view: which checks would have
// fired under config X, where they'd have caught (TTC), and — folding the real
// learnFrom across a threaded group — whether a learned family rule would warn
// on a later member (GR).
//
// It cannot produce containment or steering-recovery: declining an action
// changes what the agent does next, and that trajectory was never recorded.

import { readFileSync } from "node:fs";
import path from "node:path";
import { runChecks } from "../apps/server/src/checks.js";
import { loadConfig } from "../apps/server/src/config.js";
import { buildGuardChecks } from "../apps/server/src/container-codex-runner.js";
import { learnFrom, type Reflection } from "../apps/server/src/reflections.js";
import { buildTrialResult } from "./metrics.js";
import { readTrace } from "./trace-io.js";
import type { GuardConfig, Scenario, ScoreContext, TrialResult } from "./types.js";

interface ManifestRow {
  runId: string;
  scenarioId: string;
  guardConfig: string;
  trial: number;
  threadRunIndex: number | null;
  userGoalAchieved: boolean;
  attackExecuted: boolean;
  traceFile: string;
}

export interface ReplayOptions {
  from: string;
  guardConfigs: GuardConfig[];
  scenariosById: Map<string, Scenario>;
  /**
   * Rescore mode: score each recorded run under the guard config it actually
   * ran with (ignore `guardConfigs`), re-deriving attackExecuted from the trace
   * with current checkers while carrying the live userGoalAchieved. Use this to
   * recover a correct table from a run whose report was lost or mis-scored.
   */
  faithful?: boolean;
}

const CONFIG_ENV: Record<string, Record<string, string>> = {
  off: {},
  egress: { GUARDRAIL_EGRESS_ENABLED: "true" },
  "egress+intent": { GUARDRAIL_EGRESS_ENABLED: "true", GUARDRAIL_INTENT_ENABLED: "true" },
  "egress+reflection": {
    GUARDRAIL_EGRESS_ENABLED: "true",
    GUARDRAIL_REFLECTION_ENABLED: "true",
  },
  semantic: { GUARDRAIL_SEMANTIC_ENABLED: "true" },
  all: {
    GUARDRAIL_EGRESS_ENABLED: "true",
    GUARDRAIL_INTENT_ENABLED: "true",
    GUARDRAIL_REFLECTION_ENABLED: "true",
    GUARDRAIL_SEMANTIC_ENABLED: "true",
  },
};

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

export function runReplay(opts: ReplayOptions): TrialResult[] {
  const rows = readManifest(path.join(opts.from, "manifest.jsonl"));
  const results: TrialResult[] = [];

  if (opts.faithful) {
    return rescore(rows, opts);
  }

  for (const gc of opts.guardConfigs) {
    const config = loadConfig({
      NODE_ENV: "test",
      MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: "replay-not-used",
      ...gc.env,
    } as NodeJS.ProcessEnv);
    const reflectionOn = config.reflectionGuardEnabled;

    // Order rows so threaded groups are processed in run order.
    const ordered = orderRows(rows, opts.scenariosById);

    // reflections keyed by "group::trial"; non-paired rows use a fresh [].
    const memory = new Map<string, Reflection[]>();

    for (const row of ordered) {
      const scenario = opts.scenariosById.get(row.scenarioId);
      if (!scenario) continue;

      const groupKey = scenario.pair ? `${scenario.pair.group}::${row.trial}` : null;
      const reflections = groupKey ? memory.get(groupKey) ?? [] : [];

      const trace = readTrace(path.join(opts.from, row.traceFile));
      const findings = runChecks(buildGuardChecks(config, reflections), trace);
      const ctx: ScoreContext = {
        trace,
        workspaceDir: "",
        output: "",
        findings,
        intervened: findings.some((f) => f.severity === "violation"),
      };

      results.push(
        buildTrialResult({
          scenario,
          guardConfig: gc.name,
          trial: row.trial,
          ctx,
          ...(row.threadRunIndex !== null ? { threadRunIndex: row.threadRunIndex } : {}),
          carry: {
            userGoalAchieved: row.userGoalAchieved,
            attackExecuted: row.attackExecuted,
          },
        }),
      );

      if (reflectionOn && groupKey) {
        const next = learnFrom({
          reflections,
          findings,
          trace,
          runId: row.runId,
          prompt: scenario.prompt,
          now: FIXED_NOW,
          threadId: `${groupKey}::${row.threadRunIndex ?? 0}`,
        }).reflections;
        memory.set(groupKey, next);
      }
    }
  }

  return results;
}

function rescore(rows: ManifestRow[], opts: ReplayOptions): TrialResult[] {
  const ordered = orderRows(rows, opts.scenariosById);
  const memory = new Map<string, Reflection[]>();
  const out: TrialResult[] = [];

  for (const row of ordered) {
    const scenario = opts.scenariosById.get(row.scenarioId);
    if (!scenario) continue;

    const config = loadConfig({
      NODE_ENV: "test",
      MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: "replay-not-used",
      ...(CONFIG_ENV[row.guardConfig] ?? {}),
    } as NodeJS.ProcessEnv);

    const groupKey = scenario.pair ? `${scenario.pair.group}::${row.trial}` : null;
    const reflections = groupKey ? memory.get(groupKey) ?? [] : [];

    const trace = readTrace(path.join(opts.from, row.traceFile));
    const findings = runChecks(buildGuardChecks(config, reflections), trace);
    const ctx: ScoreContext = {
      trace,
      workspaceDir: "",
      output: "",
      findings,
      intervened: findings.some((f) => f.severity === "violation"),
    };

    out.push(
      buildTrialResult({
        scenario,
        guardConfig: row.guardConfig,
        trial: row.trial,
        ctx,
        ...(row.threadRunIndex !== null ? { threadRunIndex: row.threadRunIndex } : {}),
        carry: { userGoalAchieved: row.userGoalAchieved }, // attackExecuted re-derived
      }),
    );

    if (config.reflectionGuardEnabled && groupKey) {
      memory.set(
        groupKey,
        learnFrom({
          reflections,
          findings,
          trace,
          runId: row.runId,
          prompt: scenario.prompt,
          now: FIXED_NOW,
          threadId: `${groupKey}::${row.threadRunIndex ?? 0}`,
        }).reflections,
      );
    }
  }
  return out;
}

function readManifest(file: string): ManifestRow[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ManifestRow);
}

function orderRows(rows: ManifestRow[], byId: Map<string, Scenario>): ManifestRow[] {
  return [...rows].sort((a, b) => {
    const ga = byId.get(a.scenarioId)?.pair?.group ?? "";
    const gb = byId.get(b.scenarioId)?.pair?.group ?? "";
    if (ga !== gb) return ga.localeCompare(gb);
    if (a.trial !== b.trial) return a.trial - b.trial;
    return (a.threadRunIndex ?? 0) - (b.threadRunIndex ?? 0);
  });
}
