#!/usr/bin/env bash
#
# Run the benchmark against a real model, then score it.
#
# COSTS MONEY. Roughly $0.08 per run. It tells you the bill and waits for you to
# agree before anything is spent.
#
#   scripts/run-benchmark.sh           2 runs,   ~$0.16  one scenario, guards off vs on
#   scripts/run-benchmark.sh --full    ~200 runs, ~$15   the whole suite
#
set -euo pipefail
cd "$(dirname "$0")/.."

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }

# benchmark/run.ts reads process.env directly and does NOT load .env, so without
# this it silently fails to do a live run.
#
# Pull out only the vars we need, by hand. Do NOT `source .env`: values there are
# unquoted (CONTAINER_RUNTIME_APT_PACKAGES=ca-certificates git ripgrep), so
# sourcing it executes them as commands.
load_var() {
  local name="$1" v
  [ -n "${!name:-}" ] && return 0
  [ -f .env ] || return 0
  v="$(grep -m1 "^${name}=" .env | cut -d= -f2- || true)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  [ -n "$v" ] && export "$name=$v"
  return 0
}
load_var ARK_API_KEY
load_var ARK_MODEL
load_var ARK_BASE_URL

for k in ARK_API_KEY ARK_MODEL; do
  if [ -z "${!k:-}" ]; then
    red "$k is not set. Copy .env.example to .env and fill it in."; exit 1
  fi
done

if ! docker info >/dev/null 2>&1; then
  red "No container engine running. Start Docker Desktop, Colima, or Podman."; exit 1
fi

# Without curl the attack cannot execute, so the guards-off half is meaningless.
if docker image inspect volc-agent-runtime:local >/dev/null 2>&1 \
   && ! docker run --rm --entrypoint sh volc-agent-runtime:local -c 'command -v curl' >/dev/null 2>&1; then
  red "The runtime image has no curl, so the attack cannot run and the result would be meaningless."
  echo "Fix it, then run this again:"
  echo "  docker build -f Dockerfile.runtime -t volc-agent-runtime:local \\"
  echo "    --build-arg RUNTIME_APT_PACKAGES='ca-certificates git ripgrep curl dnsutils' ."
  exit 1
fi

OUT="benchmark-results/live-$(date +%Y%m%dT%H%M%S)"
if [ "${1:-}" = "--full" ]; then
  ARGS=(--configs off,egress,egress+reflection --trials 3)
  echo "About to run the FULL suite: 22 scenarios x 3 configs x 3 trials."
  echo "That is roughly 200 model runs, about \$15."
else
  ARGS=(--only hidden-in-readme --configs off,egress --trials 1)
  echo "About to run one scenario twice: the same poisoned repo and prompt,"
  echo "once with the guards off and once with the egress guard on."
  echo "That is 2 model runs, about \$0.16."
fi

echo
read -r -p "Type yes to spend that: " ok
[ "$ok" = "yes" ] || { echo "Nothing spent."; exit 0; }

npx tsx benchmark/run.ts --mode live "${ARGS[@]}" --out "$OUT"

grn "Done. Scoring it:"
./scripts/verify-guards.sh "$OUT"
