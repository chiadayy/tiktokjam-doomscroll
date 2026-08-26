#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

env_file="${1:-.env.production}"
if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file. Copy .env.example and fill ARK_API_KEY / ARK_MODEL." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker Engine 24 or newer is required. Follow the Linux install section in README.md." >&2
  exit 1
fi

docker_server_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
docker_server_major="${docker_server_version%%.*}"
if [[ ! "$docker_server_major" =~ ^[0-9]+$ ]] || (( docker_server_major < 24 )); then
  echo "Docker Engine 24 or newer is required; found '${docker_server_version:-unavailable}'." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "The Docker Compose plugin is required (the command must be 'docker compose')." >&2
  exit 1
fi

mkdir -p data workspaces codex-home
if [[ "$(stat -c '%u:%g' data)" != "1000:1000" ]] \
  || [[ "$(stat -c '%u:%g' workspaces)" != "1000:1000" ]] \
  || [[ "$(stat -c '%u:%g' codex-home)" != "1000:1000" ]]; then
  if [[ "$(id -u)" -eq 0 ]]; then
    chown -R 1000:1000 data workspaces codex-home
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo chown -R 1000:1000 data workspaces codex-home
  else
    echo "data, workspaces and codex-home must be owned by UID:GID 1000:1000." >&2
    echo "Run: sudo chown -R 1000:1000 data workspaces codex-home" >&2
    exit 1
  fi
fi
export LAUNCHPAD_ENV_FILE="$env_file"

docker compose --env-file "$env_file" up -d --build

requested_sandbox_mode="$(sed -n 's/^CODEX_SANDBOX_MODE=//p' "$env_file" | tail -n 1)"
requested_sandbox_mode="${requested_sandbox_mode:-workspace-write}"
if [[ "$requested_sandbox_mode" == "workspace-write" ]] \
  && ! docker compose --env-file "$env_file" exec -T launchpad \
    codex sandbox linux --full-auto -- true >/dev/null 2>&1; then
  echo "Codex Landlock is unavailable on this Linux kernel/container runtime." >&2
  echo "Falling back to danger-full-access inside the outer Docker boundary." >&2
  echo "This POC does not provide per-Agent isolation; do not store unrelated secrets in it." >&2
  export CODEX_SANDBOX_MODE=danger-full-access
  docker compose --env-file "$env_file" up -d --no-build --force-recreate
fi
docker compose --env-file "$env_file" ps

public_port="$(sed -n 's/^PUBLIC_PORT=//p' "$env_file" | tail -n 1)"
echo "Agent Launchpad is starting on port ${public_port:-3000}."
