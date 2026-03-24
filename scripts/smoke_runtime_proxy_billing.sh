#!/usr/bin/env bash
# Live smoke: deployed backend health + runtime-proxy billing paths.
#
# Required:
#   AGENTOS_BACKEND_URL   e.g. https://your-app.up.railway.app
#   EDGE_INGEST_TOKEN     same value as worker BACKEND_INGEST_TOKEN / EDGE_INGEST_TOKEN
#
# Optional:
#   SMOKE_AUTH_EMAIL + SMOKE_AUTH_PASSWORD  — signup/login (password min 8 chars), then /auth/me org_id for billing + cost-ledger check
#   SMOKE_JWT                               — skip signup/login; use this Bearer token for observability/billing GETs
#   SMOKE_LLM=1                             — also POST /runtime-proxy/llm/infer (uses real GMI quota / spend)
#   SMOKE_LLM_MODEL                         — default deepseek-ai/DeepSeek-V3.2
#
# Usage:
#   export AGENTOS_BACKEND_URL=https://...
#   export EDGE_INGEST_TOKEN=...
#   export SMOKE_AUTH_EMAIL=you@example.com SMOKE_AUTH_PASSWORD='your-password'
#   bash scripts/smoke_runtime_proxy_billing.sh

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BASE_URL="${AGENTOS_BACKEND_URL:-}"
EDGE_TOKEN="${EDGE_INGEST_TOKEN:-}"
SMOKE_LLM="${SMOKE_LLM:-0}"
SMOKE_LLM_MODEL="${SMOKE_LLM_MODEL:-deepseek-ai/DeepSeek-V3.2}"

COLOR_RESET="\033[0m"
COLOR_GREEN="\033[32m"
COLOR_RED="\033[31m"
COLOR_YELLOW="\033[33m"
COLOR_CYAN="\033[36m"

ok() { echo -e "${COLOR_GREEN}OK${COLOR_RESET} $*"; }
fail() { echo -e "${COLOR_RED}FAIL${COLOR_RESET} $*"; exit 1; }
info() { echo -e "${COLOR_CYAN}--${COLOR_RESET} $*"; }
warn() { echo -e "${COLOR_YELLOW}WARN${COLOR_RESET} $*"; }

json_field() {
  local key="$1"
  python3 - "$key" <<'PY'
import json, sys
key = sys.argv[1]
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception:
    print("")
    raise SystemExit(0)
value = data.get(key, "")
if isinstance(value, (dict, list)):
    print(json.dumps(value))
else:
    print(value if value is not None else "")
PY
}

require_env() {
  [[ -n "$BASE_URL" ]] || fail "Set AGENTOS_BACKEND_URL"
  [[ -n "$EDGE_TOKEN" ]] || fail "Set EDGE_INGEST_TOKEN"
  BASE_URL="${BASE_URL%/}"
}

http_get() {
  local url="$1"
  local auth_header="${2:-}"
  if [[ -n "$auth_header" ]]; then
    curl -sS -w "\n%{http_code}" -H "$auth_header" "$url"
  else
    curl -sS -w "\n%{http_code}" "$url"
  fi
}

http_post_json() {
  local url="$1"
  local body="$2"
  shift 2
  curl -sS -w "\n%{http_code}" -X POST "$url" \
    -H "Content-Type: application/json" \
    "$@" \
    --data-binary "$body"
}

parse_curl_body_code() {
  # stdin: body\nCODE — sets BODY and CODE globals
  local raw
  raw=$(cat)
  CODE=$(echo "$raw" | tail -n1)
  BODY=$(echo "$raw" | sed '$d')
}

require_env

RUN_ID="smoke-rp-$(date +%s)-$RANDOM"
ORG_ID="${SMOKE_ORG_ID:-}"
JWT="${SMOKE_JWT:-}"

if [[ -z "$JWT" && -n "${SMOKE_AUTH_EMAIL:-}" ]]; then
  info "Authenticating as ${SMOKE_AUTH_EMAIL}..."
  SIGN_BODY=$(http_post_json "${BASE_URL}/api/v1/auth/signup" "{\"email\":\"${SMOKE_AUTH_EMAIL}\",\"password\":\"${SMOKE_AUTH_PASSWORD:-}\"}" || true)
  parse_curl_body_code <<<"$SIGN_BODY"
  if [[ "$CODE" == "200" ]]; then
    JWT="$(printf '%s' "$BODY" | json_field token)"
  elif [[ "$CODE" == "409" ]]; then
    LOGIN_BODY=$(http_post_json "${BASE_URL}/api/v1/auth/login" "{\"email\":\"${SMOKE_AUTH_EMAIL}\",\"password\":\"${SMOKE_AUTH_PASSWORD:-}\"}")
    parse_curl_body_code <<<"$LOGIN_BODY"
    [[ "$CODE" == "200" ]] || fail "Login failed HTTP $CODE: $BODY"
    JWT="$(printf '%s' "$BODY" | json_field token)"
  else
    fail "Signup failed HTTP $CODE: $BODY"
  fi
  [[ -n "$JWT" ]] || fail "No JWT from auth"
fi

if [[ -n "$JWT" ]]; then
  ME_RAW=$(http_get "${BASE_URL}/api/v1/auth/me" "Authorization: Bearer ${JWT}")
  parse_curl_body_code <<<"$ME_RAW"
  [[ "$CODE" == "200" ]] || fail "/auth/me failed HTTP $CODE: $BODY"
  ORG_ID="$(printf '%s' "$BODY" | json_field org_id)"
  [[ -n "$ORG_ID" ]] || warn "org_id empty from /auth/me; billing usage may not include this run"
fi

info "Health ${BASE_URL}/api/v1/health"
H_RAW=$(curl -sS -w "\n%{http_code}" "${BASE_URL}/api/v1/health")
parse_curl_body_code <<<"$H_RAW"
[[ "$CODE" == "200" ]] || fail "Health HTTP $CODE: $BODY"
ok "health"

TOOL_JSON=$(python3 - <<PY
import json
print(json.dumps({
  "tool": "web-search",
  "args": {"query": "AgentOS billing smoke test"},
  "session_id": "${RUN_ID}",
  "org_id": "${ORG_ID}",
  "project_id": "",
  "agent_name": "smoke-runtime-proxy",
}))
PY
)

info "POST /api/v1/runtime-proxy/tool/call (session=${RUN_ID})"
T_RAW=$(curl -sS -w "\n%{http_code}" -X POST "${BASE_URL}/api/v1/runtime-proxy/tool/call" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${EDGE_TOKEN}" \
  -H "X-Edge-Token: ${EDGE_TOKEN}" \
  -d "$TOOL_JSON")
parse_curl_body_code <<<"$T_RAW"
[[ "$CODE" == "200" ]] || fail "tool/call HTTP $CODE: $BODY"
TOOL_COST="$(printf '%s' "$BODY" | json_field cost_usd)"
[[ -n "$TOOL_COST" ]] || fail "tool/call missing cost_usd"
ok "tool/call cost_usd=${TOOL_COST}"

SAN_JSON=$(python3 - <<PY
import json
print(json.dumps({
  "command": "echo smoke_ok",
  "timeout_seconds": 15,
  "session_id": "${RUN_ID}",
  "org_id": "${ORG_ID}",
  "project_id": "",
  "agent_name": "smoke-runtime-proxy",
}))
PY
)

info "POST /api/v1/runtime-proxy/sandbox/exec"
S_RAW=$(curl -sS -w "\n%{http_code}" -X POST "${BASE_URL}/api/v1/runtime-proxy/sandbox/exec" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${EDGE_TOKEN}" \
  -H "X-Edge-Token: ${EDGE_TOKEN}" \
  -d "$SAN_JSON")
parse_curl_body_code <<<"$S_RAW"
[[ "$CODE" == "200" ]] || fail "sandbox/exec HTTP $CODE: $BODY"
SAN_COST="$(printf '%s' "$BODY" | json_field cost_usd)"
[[ -n "$SAN_COST" ]] || fail "sandbox/exec missing cost_usd"
ok "sandbox/exec cost_usd=${SAN_COST}"

if [[ "$SMOKE_LLM" == "1" ]]; then
  LLM_JSON=$(python3 - <<PY
import json
print(json.dumps({
  "messages": [{"role": "user", "content": "Reply with exactly: smoke_llm_ok"}],
  "provider": "gmi",
  "model": "${SMOKE_LLM_MODEL}",
  "max_tokens": 32,
  "temperature": 0.0,
  "session_id": "${RUN_ID}-llm",
  "org_id": "${ORG_ID}",
  "agent_name": "smoke-runtime-proxy",
}))
PY
)
  info "POST /api/v1/runtime-proxy/llm/infer (SMOKE_LLM=1, model=${SMOKE_LLM_MODEL})"
  L_RAW=$(curl -sS -w "\n%{http_code}" -X POST "${BASE_URL}/api/v1/runtime-proxy/llm/infer" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${EDGE_TOKEN}" \
    -H "X-Edge-Token: ${EDGE_TOKEN}" \
    -d "$LLM_JSON")
  parse_curl_body_code <<<"$L_RAW"
  [[ "$CODE" == "200" ]] || fail "llm/infer HTTP $CODE: $BODY"
  LLM_COST="$(printf '%s' "$BODY" | json_field cost_usd)"
  [[ -n "$LLM_COST" ]] || fail "llm/infer missing cost_usd"
  ok "llm/infer cost_usd=${LLM_COST}"
fi

if [[ -n "$JWT" ]]; then
  info "GET /api/v1/observability/cost-ledger (looking for session_id=${RUN_ID})"
  CL_RAW=$(http_get "${BASE_URL}/api/v1/observability/cost-ledger?limit=200" "Authorization: Bearer ${JWT}")
  parse_curl_body_code <<<"$CL_RAW"
  [[ "$CODE" == "200" ]] || fail "cost-ledger HTTP $CODE: $BODY"
  FOUND=$(printf '%s' "$BODY" | python3 - "$RUN_ID" <<'PY'
import json, sys
run = sys.argv[1]
data = json.load(sys.stdin)
entries = data.get("entries") or []
print("yes" if any((e.get("session_id") or "") == run for e in entries) else "no")
PY
)
  [[ "$FOUND" == "yes" ]] || fail "cost-ledger has no entry for session_id=${RUN_ID}"
  ok "cost-ledger contains session ${RUN_ID}"

  if [[ -n "$ORG_ID" ]]; then
    info "GET /api/v1/billing/usage (org-scoped summary)"
    U_RAW=$(http_get "${BASE_URL}/api/v1/billing/usage?since_days=1" "Authorization: Bearer ${JWT}")
    parse_curl_body_code <<<"$U_RAW"
    [[ "$CODE" == "200" ]] || fail "billing/usage HTTP $CODE: $BODY"
    ok "billing/usage total_billing_records=$(printf '%s' "$BODY" | json_field total_billing_records)"
  fi
else
  warn "No JWT: skipped cost-ledger and billing/usage (set SMOKE_JWT or SMOKE_AUTH_EMAIL + SMOKE_AUTH_PASSWORD)"
fi

ok "Smoke complete (run_id=${RUN_ID})"
