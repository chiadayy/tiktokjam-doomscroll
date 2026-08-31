#!/usr/bin/env -S npx tsx
// The leash benchmark.
//
//   npx tsx benchmark/run.ts --mode live   --configs off,egress --trials 3
//   npx tsx benchmark/run.ts --mode replay --from benchmark-results/<run> --configs off,egress,egress+reflection
//
// LIVE drives the real container + Codex + model (costs API tokens) and records
// every trace. REPLAY re-scores recorded traces under other guard configs for
// free. See docs/BENCHMARK.md.

import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGuardConfigs } from "./guard-configs.js";
import { runReplay } from "./replay.js";
import { runLive } from "./run-live.js";
import { writeReport } from "./report.js";
import { PAIRED_GROUPS, SCENARIOS, SCENARIOS_BY_ID } from "./scenarios/index.js";
import type { Scenario } from "./types.js";

interface Args {
  mode: "live" | "replay";
  scenarios: string;
  only: string | null;
  configs: string;
  trials: number;
  paired: string;
  from: string | null;
  out: string | null;
  workspaceRoot: string | null;
  stateRoot: string | null;
  keepWorkspaces: boolean;
  faithful: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    mode: "live",
    scenarios: "all",
    only: null,
    configs: "off,egress",
    trials: 3,
    paired: "rotation",
    from: null,
    out: null,
    workspaceRoot: null,
    stateRoot: null,
    keepWorkspaces: false,
    faithful: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[(i += 1)];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--mode": {
        const m = next();
        if (m !== "live" && m !== "replay") throw new Error(`--mode must be live|replay`);
        a.mode = m;
        break;
      }
      case "--scenarios": a.scenarios = next(); break;
      case "--only": a.only = next(); break;
      case "--configs": a.configs = next(); break;
      case "--trials": a.trials = Number(next()); break;
      case "--paired": a.paired = next(); break;
      case "--from": a.from = next(); break;
      case "--faithful": a.faithful = true; break;
      case "--out": a.out = next(); break;
      case "--workspace-root": a.workspaceRoot = next(); break;
      case "--state-root": a.stateRoot = next(); break;
      case "--keep-workspaces": a.keepWorkspaces = true; break;
      case "--help": case "-h": printHelp(); process.exit(0); break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  if (a.mode === "replay" && a.from === null) {
    throw new Error("--mode replay needs --from <results dir>");
  }
  if (!Number.isFinite(a.trials) || a.trials < 1) throw new Error("--trials must be >= 1");
  return a;
}

function printHelp(): void {
  console.log(
    [
      "leash benchmark",
      "",
      "  --mode live|replay          (required)",
      "  --configs off,egress,...    guard configs (default: off,egress)",
      "                              known: off egress egress+intent egress+reflection semantic all",
      "  --scenarios all|<family|id,...>   default: all",
      "  --only <id,...>             restrict to these scenario ids",
      "  --paired rotation|none      reflection-threaded groups (default: rotation)",
      "  --trials N                  trials per cell, live only (default: 3)",
      "  --from <dir>                replay: a prior --out directory",
      "  --out <dir>                 default: benchmark-results/<timestamp>",
      "  --workspace-root <dir>      live: bind-mountable dir for fixtures",
      "  --state-root <dir>          live: parent of APP_DATA_DIR / CODEX_HOME",
      "  --keep-workspaces           live: do not delete fixture dirs",
    ].join("\n"),
  );
}

function selectScenarios(args: Args): Scenario[] {
  let picked = SCENARIOS;
  if (args.scenarios !== "all") {
    const wanted = new Set(args.scenarios.split(",").map((s) => s.trim()));
    picked = picked.filter((s) => wanted.has(s.family) || wanted.has(s.id));
  }
  if (args.only) {
    const ids = new Set(args.only.split(",").map((s) => s.trim()));
    picked = picked.filter((s) => ids.has(s.id));
  }
  if (picked.length === 0) throw new Error("no scenarios matched the selection");
  return picked;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const guardConfigs = parseGuardConfigs(args.configs);
  const scenarios = selectScenarios(args);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(args.out ?? path.join("benchmark-results", stamp));
  mkdirSync(outDir, { recursive: true });

  const pairedGroups =
    args.paired === "none" ? [] : args.paired.split(",").map((s) => s.trim()).filter(Boolean);

  console.error(
    `mode=${args.mode} scenarios=${scenarios.length} configs=${guardConfigs
      .map((g) => g.name)
      .join(",")} out=${outDir}`,
  );

  let results;
  if (args.mode === "live") {
    const haveArk = !!(process.env.ARK_API_KEY && process.env.ARK_MODEL);
    const haveOpenAi = !!process.env.OPENAI_API_KEY;
    if (!haveArk && !haveOpenAi) {
      throw new Error(
        "live mode needs model credentials: set ARK_API_KEY + ARK_MODEL " +
          "(or MODEL_PROVIDER=openai + OPENAI_API_KEY), same as `npm run poc`.",
      );
    }
    const home = os.homedir();
    const workspaceRoot = path.resolve(
      args.workspaceRoot ??
        process.env.BENCH_WORKSPACE_ROOT ??
        path.join(home, ".volc-agent-launchpad", "benchmark-workspaces"),
    );
    const stateRoot = path.resolve(
      args.stateRoot ??
        process.env.LOCAL_POC_DATA_ROOT ??
        path.join(home, ".volc-agent-launchpad"),
    );
    results = await runLive({
      scenarios,
      guardConfigs,
      trials: args.trials,
      outDir,
      pairedGroups,
      pairedMembers: PAIRED_GROUPS,
      workspaceRoot,
      stateRoot,
      keepWorkspaces: args.keepWorkspaces,
    });
  } else {
    if (!existsSync(path.join(args.from!, "manifest.jsonl"))) {
      throw new Error(`${args.from}/manifest.jsonl not found — is that a benchmark --out dir?`);
    }
    results = runReplay({
      from: path.resolve(args.from!),
      guardConfigs,
      scenariosById: SCENARIOS_BY_ID,
      faithful: args.faithful,
    });
  }

  const md = writeReport({
    mode: args.mode,
    guardConfigs: guardConfigs.map((g) => g.name),
    results,
    scenariosById: SCENARIOS_BY_ID,
    outDir,
  });
  console.log("\n" + md);
  console.error(`\nwrote ${outDir}/report.md and ${outDir}/results.json`);
}

main().catch((err) => {
  console.error(`\nbenchmark failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
