// Read a run's JSON Lines trace into TraceRecord[]. A malformed line is an
// error, not a silent skip — a hole changes the findings (same rule as
// scripts/replay-trace.ts).

import { readFileSync } from "node:fs";
import type { TraceRecord } from "../apps/server/src/trace.js";

export function readTrace(file: string): TraceRecord[] {
  const records: TraceRecord[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    try {
      records.push(JSON.parse(line) as TraceRecord);
    } catch {
      throw new Error(`${file}:${i + 1} is not valid JSON`);
    }
  });
  return records;
}
