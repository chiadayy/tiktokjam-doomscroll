#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ -z "${VOLCENGINE_ACCESS_KEY:-}" || -z "${VOLCENGINE_SECRET_KEY:-}" ]]; then
  echo "Export VOLCENGINE_ACCESS_KEY and VOLCENGINE_SECRET_KEY first." >&2
  exit 1
fi

if [[ ! -f .env.production ]]; then
  echo "Missing .env.production. Copy .env.example and fill the Ark values." >&2
  exit 1
fi

if [[ ! -f deploy/volcengine/terraform.tfvars ]]; then
  echo "Missing deploy/volcengine/terraform.tfvars." >&2
  echo "Copy terraform.tfvars.example and fill the region-specific values." >&2
  exit 1
fi

set -a
source .env.production
set +a

if [[ "${ARK_API_KEY:-}" == "" || "${ARK_MODEL:-}" == "" || "${APP_AUTH_TOKEN:-}" == "" ]]; then
  echo "ARK_API_KEY, ARK_MODEL and APP_AUTH_TOKEN are required in .env.production." >&2
  exit 1
fi

export TF_VAR_ark_api_key="$ARK_API_KEY"
export TF_VAR_app_auth_token="$APP_AUTH_TOKEN"
export TF_VAR_ark_model="$ARK_MODEL"
export TF_VAR_ark_base_url="${ARK_BASE_URL:-https://ark.cn-beijing.volces.com/api/v3}"

terraform -chdir=deploy/volcengine init
terraform -chdir=deploy/volcengine apply

echo
echo "Deployment requested. Cloud-init may take 5-10 minutes."
terraform -chdir=deploy/volcengine output app_url
