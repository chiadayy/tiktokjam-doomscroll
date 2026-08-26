#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

mkdir -p data workspaces codex-home

echo "Next:"
echo "  1. Fill ARK_API_KEY and ARK_MODEL in .env"
echo "  2. Run: docker compose up --build"
