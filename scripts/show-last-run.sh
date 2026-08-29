#!/usr/bin/env bash
# What the guards did on the most recent run, and what the Agent now carries.
#
# Local state lives outside the repo — under ~/.volc-agent-launchpad by default,
# or $LOCAL_POC_DATA_ROOT if you set one — so there is nothing to look at in the
# working tree. This prints the parts worth reading.
#
# Usage:
#   scripts/show-last-run.sh        # newest run
#   scripts/show-last-run.sh 3      # the 3 newest runs

set -euo pipefail

state_root="${LOCAL_POC_DATA_ROOT:-$HOME/.volc-agent-launchpad}"
data_dir="${APP_DATA_DIR:-$state_root/data}"
db="$data_dir/launchpad.json"

[[ -f "$db" ]] || { echo "No database at $db" >&2; exit 1; }

limit="${1:-1}"

node - "$db" "$limit" <<'JS'
const [dbPath, limitArg] = process.argv.slice(2);
const db = require(dbPath);
const limit = Number(limitArg) || 1;

const runs = db.runs
  .slice()
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  .slice(0, limit)
  .reverse();

for (const run of runs) {
  const agent = db.agents.find((a) => a.id === run.agentId);
  console.log("=".repeat(72));
  console.log(`${run.createdAt}  ${run.status}  agent: ${agent?.name ?? "?"}`);
  console.log(`prompt: ${JSON.stringify(run.prompt)}`);
  console.log(`intervened: ${run.intervened === true}`);

  const findings = run.findings ?? [];
  console.log(`\nfindings (${findings.length}):`);
  for (const f of findings) {
    console.log(`  [${f.severity}] ${f.check} / ${f.code}  seq ${f.seq}`);
    if (f.facts) console.log(`      facts: ${JSON.stringify(f.facts)}`);
    console.log(`      ${f.message}`);
  }
  if (findings.length === 0) {
    console.log("  none — check the trace for whether the Agent even attempted");
    console.log("  the guarded action. A refusal by the model is not a guard result.");
  }

  const reflections = agent?.reflections ?? [];
  console.log(`\nreflections this Agent carries (${reflections.length}):`);
  for (const r of reflections) {
    console.log(`  ${r.code}  ${JSON.stringify(r.facts)}  seen in ${r.sightings.length} run(s)`);
  }

  console.log(`\ntrace: ${run.trace?.path ?? "none"}`);
}
JS

latest_trace=$(node -e '
  const db = require("'"$db"'");
  const run = db.runs.slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  process.stdout.write(run?.trace?.path ?? "");
')

if [[ -n "$latest_trace" && -f "$latest_trace" ]]; then
  echo
  echo "commands the Agent ran (newest run):"
  node - "$latest_trace" <<'JS'
const fs = require("fs");
for (const line of fs.readFileSync(process.argv[2], "utf8").trim().split("\n")) {
  let record;
  try { record = JSON.parse(line); } catch { continue; }
  const item = record?.payload?.params?.item;
  if (item?.type === "commandExecution" && record.method === "item/started") {
    console.log(`  ${record.seq}  ${String(item.command).slice(0, 110)}`);
  }
}
JS
  echo
  echo "approval requests (the guard's decision points): $(grep -c requestApproval "$latest_trace" || true)"
fi
