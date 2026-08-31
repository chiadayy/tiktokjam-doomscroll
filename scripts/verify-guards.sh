#!/usr/bin/env bash
# Verify the guardrails without an API key, a model, or a container.
#
# Also called by run-benchmark.sh to score a live run - do not delete.
#
# Runs the unit suite, then re-derives the committed benchmark results straight
# from the raw recorded traces. No model calls, nothing spent.
#
# Note the --faithful flag below: it re-scores each run under the guard config it
# actually ran with. Replay cannot fabricate containment (declining an action
# changes what the agent does next, which was never recorded), so re-scoring a
# guarded run under "off" would report the wrong outcome.
set -euo pipefail
cd "$(dirname "$0")/.."

# Defaults to the committed slice; pass a directory to verify your own live run.
SLICE="${1:-benchmark-results/2026-08-31-slice}"

if [ ! -d "$SLICE/traces" ]; then
  echo "no traces in $SLICE" >&2
  echo "usage: $0 [benchmark-results/<run-dir>]" >&2
  exit 1
fi
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

echo "Verifying: $SLICE"
echo
echo "==> 1/3  Unit suite (guards, redaction, reflections, runtime)"
npm run --silent check

echo
echo "==> 2/3  Benchmark harness tests"
npx tsc --noEmit -p benchmark/tsconfig.json
npx vitest run --config benchmark/vitest.config.ts --reporter=dot

echo
echo "==> 3/3  Re-deriving the results from $(ls "$SLICE"/traces/*.jsonl | wc -l | tr -d ' ') recorded live runs"
npx tsx benchmark/run.ts --mode replay --faithful --from "$SLICE" \
  --configs off,egress,egress+reflection --out "$OUT" >/dev/null
sed -n '/^## Verdict/,/^## What actually happened/p' "$OUT/report.md" | sed '$d'

echo "Full report: $OUT/report.md (deleted on exit; pass --out to keep one)"
