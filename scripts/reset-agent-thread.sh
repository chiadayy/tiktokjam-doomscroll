#!/usr/bin/env bash
# Give an Agent a fresh conversation while keeping what the guards learned.
#
# An Agent has one chat thread, and it remembers everything in it. Ask it the
# same thing twice and the second run does not re-read the files — it answers
# from the conversation. That hides the behaviour this project is about, because
# a guard that watches file reads has nothing to watch.
#
# Clearing codexThreadId starts the next run as a brand new conversation. The
# Agent remembers nothing. Its reflections are stored separately, on the Agent
# record, so they survive untouched — which is the point of keeping them out of
# the prompt in the first place.
#
# Usage:
#   scripts/reset-agent-thread.sh [agent-id]              # newest Agent if omitted
#   scripts/reset-agent-thread.sh [agent-id] --forget     # also drop what it learned
#
# Stop the server first, or it will overwrite this on its next write.

set -euo pipefail

state_root="${LOCAL_POC_DATA_ROOT:-$HOME/.volc-agent-launchpad}"
data_dir="${APP_DATA_DIR:-$state_root/data}"
db="$data_dir/launchpad.json"

[[ -f "$db" ]] || { echo "No database at $db" >&2; exit 1; }

# The server keeps the whole database in memory and rewrites the file on every
# change, so an edit made underneath it is silently overwritten on its next
# write — the Agent resumes its old thread and the run proves nothing. Refuse
# rather than let that happen quietly.
# -sTCP:LISTEN matters: a plain `lsof -ti :3000` also matches a browser's dead
# client sockets on that port and reports a server that is not there.
port="${PORT:-3000}"
if lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "The server is running on port $port." >&2
  echo "Stop it first, or it will overwrite this change and the reset will not take." >&2
  exit 1
fi

forget="false"
target=""
for arg in "$@"; do
  case "$arg" in
    --forget) forget="true" ;;
    -*) echo "Unknown option: $arg" >&2; exit 1 ;;
    *) target="$arg" ;;
  esac
done

node - "$db" "$target" "$forget" <<'JS'
const fs = require("fs");
const [dbPath, wanted, forget] = process.argv.slice(2);
const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));

const agent = wanted
  ? db.agents.find((a) => a.id === wanted)
  : db.agents.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

if (!agent) {
  console.error("No such agent.");
  process.exit(1);
}

const kept = (agent.reflections ?? []).length;
agent.codexThreadId = null;
if (forget === "true") agent.reflections = [];
agent.updatedAt = new Date().toISOString();

fs.writeFileSync(dbPath, JSON.stringify(db, null, 2) + "\n", { mode: 0o600 });

console.log(`Reset the conversation for "${agent.name}" (${agent.id})`);
console.log(`  chat history: cleared — the Agent starts fresh and remembers nothing`);
console.log(
  forget === "true"
    ? `  reflections:  ${kept} cleared — starting from nothing`
    : `  reflections:  ${kept} kept — the guards remember everything`,
);
console.log("");
console.log("Send the same prompt again. The Agent will re-read the checklist,");
console.log("and learned-watch should warn at that read, before any command runs.");
JS
