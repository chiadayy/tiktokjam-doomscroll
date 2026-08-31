// Render MetricCells to a markdown table + a JSON sibling.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { agentDojoView, aggregate } from "./metrics.js";
import type { Interval, MetricCell, Scenario, TrialResult } from "./types.js";

function pct(i: Interval | null): string {
  if (i === null || Number.isNaN(i.value)) return "  –  ";
  const p = (x: number) => (x * 100).toFixed(0).padStart(3);
  return `${p(i.value)}% ±${((i.hi - i.lo) / 2 * 100).toFixed(0)}`;
}

function ttc(cell: MetricCell): string {
  if (cell.catchN === 0) return "  –  ";
  const mean = `${Math.round(cell.catchSeqMean ?? 0)} (${Math.round((cell.catchFracMean ?? 0) * 100)}%)`;
  // If this cell is threaded, also show the run0 → run1 → … breakdown.
  const perRun = cell.ttcBySeq;
  if (perRun.some((s) => s !== null)) {
    const chain = perRun.map((s) => (s === null ? "–" : Math.round(s))).join(" → ");
    return `${mean}  [${chain}]`;
  }
  return `${mean}  [n=${cell.catchN}]`;
}

export interface ReportInput {
  mode: "live" | "replay";
  guardConfigs: string[];
  results: TrialResult[];
  scenariosById: Map<string, Scenario>;
  outDir: string;
}

export function writeReport(input: ReportInput): string {
  const { results, scenariosById } = input;
  const byFamily = aggregate(results, scenariosById, "family");
  const byScenario = aggregate(results, scenariosById, "scenario");

  const lines: string[] = [];
  lines.push(`# Leash benchmark — ${input.mode} run`);
  lines.push("");
  const unit = input.mode === "replay" ? "re-scored runs" : "trials";
  lines.push(
    `${results.length} ${unit} · ${new Set(results.map((r) => r.scenarioId)).size} scenarios · ` +
      `configs: ${input.guardConfigs.join(", ")} · generated ${new Date().toISOString()}`,
  );
  if (input.mode === "replay") {
    lines.push("");
    lines.push(
      "> Replay re-scores fixed trajectories: **DR / TTC / GR** are counterfactual " +
        "(what config X would have flagged); **CR** and steering-recovery cannot be " +
        "replayed (declining an action changes what the agent does next), so a DR−CR " +
        "gap here means \"would have detected\", not \"failed to contain\".",
    );
  }
  lines.push("");
  lines.push("## Headline — by scenario family × guard config");
  lines.push("");
  lines.push(
    "| family | guard | CR | DR | DR−CR | FIR | TTC(seq by run) | GR | TCR benign | TCR under attack |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of byFamily) {
    lines.push(
      `| ${c.family} | ${c.guardConfig} | ${pct(c.cr)} | ${pct(c.dr)} | ` +
        `${c.drCrGap === null ? "–" : (c.drCrGap * 100).toFixed(0) + "pp"} | ${pct(c.fir)} | ` +
        `${ttc(c)} | ${pct(c.gr)} | ${pct(c.tcrBenign)} | ${pct(c.tcrUnderAttack)} |`,
    );
  }
  lines.push("");
  lines.push(
    "CR = attack declined before execution · DR = a warn/violation fired · " +
      "DR−CR = noticed but not stopped · FIR = guard fired on benign work · " +
      "TTC = mean seq of first catch, per thread run (run0 → run1 → …) · " +
      "GR = unseen sibling host caught by a learned family rule · TCR = task completed.",
  );
  lines.push("");

  lines.push("## AgentDojo cross-reference");
  lines.push("");
  lines.push("| guard | Benign Utility | Utility Under Attack | Targeted ASR | Untargeted ASR |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const gc of input.guardConfigs) {
    const v = agentDojoView(results, gc);
    lines.push(
      `| ${gc} | ${pct(v.benignUtility)} | ${pct(v.utilityUnderAttack)} | ` +
        `${pct(v.targetedASR)} | ${pct(v.untargetedASR)} |`,
    );
  }
  lines.push("");

  lines.push("## Attack outcomes by family × guard");
  lines.push("");
  lines.push("| family | guard | executed | blocked_by_guard | refused_by_model | not_reached |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const c of byFamily) {
    if (c.outcomes.executed + c.outcomes.blocked_by_guard + c.outcomes.refused_by_model + c.outcomes.not_reached === 0) {
      continue;
    }
    const o = c.outcomes;
    lines.push(
      `| ${c.family} | ${c.guardConfig} | ${o.executed} | ${o.blocked_by_guard} | ${o.refused_by_model} | ${o.not_reached} |`,
    );
  }
  lines.push("");

  lines.push("## Per-scenario detail");
  lines.push("");
  lines.push("| scenario | guard | CR | DR | FIR | TCR |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const c of byScenario) {
    lines.push(
      `| ${c.family} | ${c.guardConfig} | ${pct(c.cr)} | ${pct(c.dr)} | ${pct(c.fir)} | ` +
        `${pct(c.tcrBenign ?? c.tcrUnderAttack)} |`,
    );
  }
  lines.push("");

  const md = lines.join("\n");
  const mdPath = path.join(input.outDir, "report.md");
  const jsonPath = path.join(input.outDir, "results.json");
  writeFileSync(mdPath, md);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        mode: input.mode,
        generatedAt: new Date().toISOString(),
        guardConfigs: input.guardConfigs,
        byFamily,
        byScenario,
        agentDojo: input.guardConfigs.map((gc) => agentDojoView(results, gc)),
        trials: results,
      },
      null,
      2,
    ),
  );
  return md;
}
