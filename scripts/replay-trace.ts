#!/usr/bin/env -S npx tsx
// Replay a recorded trace through the deterministic guards.
//
// A check is a pure function from a trace to findings: no files, no network,
// no clock, no randomness. That is what makes this script possible at all —
// the guards that ran live against a container can be run again here, months
// later, against a file, with no Agent, no model call and no API cost.
//
// The findings printed here are produced by the same `buildGuardChecks` and
// `runChecks` the runtime calls. This is not a simulation of the guards; it is
// the guards.
//
// The semantic tier is deliberately absent. It calls a model, so it is neither
// pure nor free, and it is enforced through IntentController rather than the
// check list. Replay covers the deterministic guards only.
//
// Usage:
//   scripts/replay-trace.ts <trace.jsonl> [more.jsonl ...]
//   scripts/replay-trace.ts trace.jsonl --reflections reflections.json
//   scripts/replay-trace.ts trace.jsonl --blob-min-chars 64
//   scripts/replay-trace.ts trace.jsonl --json          # machine readable
//
// Guards default to on, since replaying with everything off finds nothing.
// Turn one off with --no-egress or --no-reflection.

import { readFileSync } from "node:fs";
import { loadConfig } from "../apps/server/src/config.js";
import { runChecks, type Finding } from "../apps/server/src/checks.js";
import { buildGuardChecks } from "../apps/server/src/container-codex-runner.js";
import type { Reflection } from "../apps/server/src/reflections.js";
import type { TraceRecord } from "../apps/server/src/trace.js";

interface Options {
  tracePaths: string[];
  reflectionsPath: string | null;
  blobMinChars: string | null;
  markers: string | null;
  egress: boolean;
  reflection: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    tracePaths: [],
    reflectionsPath: null,
    blobMinChars: null,
    markers: null,
    egress: true,
    reflection: true,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--reflections":
        options.reflectionsPath = argv[(i += 1)] ?? null;
        break;
      case "--blob-min-chars":
        options.blobMinChars = argv[(i += 1)] ?? null;
        break;
      case "--markers":
        options.markers = argv[(i += 1)] ?? null;
        break;
      case "--no-egress":
        options.egress = false;
        break;
      case "--no-reflection":
        options.reflection = false;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
        options.tracePaths.push(arg);
    }
  }

  if (options.tracePaths.length === 0) {
    throw new Error("Give at least one trace file. See the header for usage.");
  }
  return options;
}

/**
 * A trace is JSON Lines. A malformed line is reported rather than skipped
 * silently — a hole in a replayed trace changes the findings, and a quiet
 * hole would make this tool lie.
 */
function readTrace(path: string): TraceRecord[] {
  const records: TraceRecord[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      records.push(JSON.parse(line) as TraceRecord);
    } catch {
      throw new Error(`${path}:${index + 1} is not valid JSON`);
    }
  });
  return records;
}

function readReflections(path: string | null): Reflection[] {
  if (path === null) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  // Accept either a bare array or a whole Agent record, so this takes what
  // `launchpad.json` already holds without anyone reshaping it by hand.
  if (Array.isArray(parsed)) return parsed as Reflection[];
  if (parsed !== null && typeof parsed === "object" && "reflections" in parsed) {
    return ((parsed as { reflections?: Reflection[] }).reflections ?? []);
  }
  throw new Error(`${path} is neither an array of reflections nor an Agent record`);
}

/**
 * Build config from an explicit environment rather than the operator's `.env`,
 * so a replay of the same trace gives the same findings on every machine.
 */
function replayConfig(options: Options) {
  return loadConfig({
    NODE_ENV: "test",
    MODEL_PROVIDER: "openai",
    OPENAI_API_KEY: "replay-not-used",
    GUARDRAIL_EGRESS_ENABLED: String(options.egress),
    GUARDRAIL_REFLECTION_ENABLED: String(options.reflection),
    ...(options.blobMinChars === null
      ? {}
      : { GUARDRAIL_BLOB_MIN_CHARS: options.blobMinChars }),
    ...(options.markers === null ? {} : { GUARDRAIL_SENSITIVE_MARKERS: options.markers }),
  } as NodeJS.ProcessEnv);
}

const SEVERITY_ORDER = { violation: 0, warn: 1, info: 2 } as const;

function report(path: string, findings: Finding[], events: number): void {
  console.log(`\n${path}`);
  console.log(`  ${events} events, ${findings.length} finding(s)`);
  if (findings.length === 0) return;

  const sorted = [...findings].sort(
    (left, right) =>
      (SEVERITY_ORDER[left.severity] ?? 9) - (SEVERITY_ORDER[right.severity] ?? 9) ||
      left.seq - right.seq,
  );
  for (const finding of sorted) {
    const label = finding.severity.toUpperCase().padEnd(9);
    console.log(`  ${label} seq ${String(finding.seq).padStart(4)}  ${finding.check} / ${finding.code}`);
    if (finding.facts) {
      console.log(`            facts: ${JSON.stringify(finding.facts)}`);
    }
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const config = replayConfig(options);
  const reflections = readReflections(options.reflectionsPath);
  const checks = buildGuardChecks(config, reflections);

  if (!options.json) {
    console.log(
      `checks: ${checks.map((check) => check.name).join(", ") || "(none — every guard is off)"}`,
    );
    if (reflections.length > 0) console.log(`reflections: ${reflections.length}`);
  }

  const results: Array<{ trace: string; events: number; findings: Finding[] }> = [];
  for (const path of options.tracePaths) {
    const trace = readTrace(path);
    const findings = runChecks(checks, trace);
    results.push({ trace: path, events: trace.length, findings: findings });
    if (!options.json) report(path, findings, trace.length);
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const violations = results.reduce(
    (total, result) =>
      total + result.findings.filter((finding) => finding.severity === "violation").length,
    0,
  );
  console.log(`\n${results.length} trace(s), ${violations} violation(s).`);
}

main();
