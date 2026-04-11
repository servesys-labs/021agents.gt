#!/usr/bin/env bash
# Sync SERVICE_TOKEN to both workers and verify runtime auth.
#
# Why this exists:
# - SERVICE_TOKEN is checked by runtime proxy endpoints.
# - Drift happens when deploy/control-plane secrets are updated separately.
# - This script provides one canonical sync flow from repo .env -> both workers.
#
# Usage:
#   ./scripts/sync_service_token.sh
#   ./scripts/sync_service_token.sh --runtime-url https://runtime.oneshots.co
#   ./scripts/sync_service_token.sh --service-token "$SERVICE_TOKEN"
#   ./scripts/sync_service_token.sh --skip-smoke

set -euo pipefail

RUNTIME_URL="https://runtime.oneshots.co"
SKIP_SMOKE="0"
SERVICE_TOKEN_OVERRIDE=""

RED="\033[31m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
RESET="\033[0m"

ok() { echo -e "${GREEN}OK${RESET} $*"; }
info() { echo -e "${CYAN}--${RESET} $*"; }
warn() { echo -e "${YELLOW}WARN${RESET} $*"; }
fail() { echo -e "${RED}FAIL${RESET} $*"; exit 1; }

usage() {
  cat <<'EOF'
sync_service_token.sh

Options:
  --runtime-url <url>   Runtime base URL for smoke check
  --service-token <v>   Token override (else SERVICE_TOKEN env/.env)
  --skip-smoke          Skip live runtime auth smoke test
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-url)
      [[ $# -ge 2 ]] || fail "--runtime-url requires a value"
      RUNTIME_URL="$2"
      shift 2
      ;;
    --skip-smoke)
      SKIP_SMOKE="1"
      shift
      ;;
    --service-token)
      [[ $# -ge 2 ]] || fail "--service-token requires a value"
      SERVICE_TOKEN_OVERRIDE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPLOY_DIR="${ROOT_DIR}/deploy"
CONTROL_PLANE_DIR="${ROOT_DIR}/control-plane"
ENV_FILE="${ROOT_DIR}/.env"
RUNTIME_URL="${RUNTIME_URL%/}"

[[ -f "$ENV_FILE" ]] || fail "Missing ${ENV_FILE}"
[[ -d "$DEPLOY_DIR" ]] || fail "Missing ${DEPLOY_DIR}"
[[ -d "$CONTROL_PLANE_DIR" ]] || fail "Missing ${CONTROL_PLANE_DIR}"

SERVICE_TOKEN="${SERVICE_TOKEN_OVERRIDE:-${SERVICE_TOKEN:-}}"
if [[ -z "$SERVICE_TOKEN" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  SERVICE_TOKEN="${SERVICE_TOKEN_OVERRIDE:-${SERVICE_TOKEN:-}}"
fi
[[ -n "$SERVICE_TOKEN" ]] || fail "SERVICE_TOKEN is empty (set env, --service-token, or ${ENV_FILE})"

sync_secret() {
  local worker_dir="$1"
  local worker_name="$2"
  info "Syncing SERVICE_TOKEN -> ${worker_name}"
  (
    cd "$worker_dir"
    printf "%s" "$SERVICE_TOKEN" | npx wrangler secret put SERVICE_TOKEN >/dev/null
  )
  ok "Synced ${worker_name}"
}

runtime_smoke() {
  info "Running runtime auth smoke at ${RUNTIME_URL}"
  local body
  body='{"input":{"input":"reply with ok"},"config":{"metadata":{"agent_name":"my-assistant","org_id":"default"}}}'
  local out
  out="$(curl -sS -w '\n%{http_code}' -X POST "${RUNTIME_URL}/api/v1/runtime-proxy/runnable/invoke" \
    -H "Authorization: Bearer ${SERVICE_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$body")"

  local resp
  local code
  resp="${out%$'\n'*}"
  code="${out##*$'\n'}"

  if [[ "$code" != "202" && "$code" != "200" ]]; then
    fail "Runtime smoke failed (HTTP ${code}). Body: ${resp:0:240}"
  fi
  ok "Runtime smoke passed (HTTP ${code})"
}

sync_secret "$DEPLOY_DIR" "deploy/agentos"
sync_secret "$CONTROL_PLANE_DIR" "control-plane/agentos-control-plane"

if [[ "$SKIP_SMOKE" == "1" ]]; then
  warn "Skipped runtime smoke test (--skip-smoke)"
else
  runtime_smoke
fi

ok "SERVICE_TOKEN sync complete"
