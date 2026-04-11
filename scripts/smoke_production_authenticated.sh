#!/usr/bin/env bash
# smoke_production_authenticated.sh — production smoke test (edge token + JWT)
#
# Tests the full stack: backend control plane, worker runtime, CF bindings, telemetry,
# and auth. Uses both auth modes:
#   - Edge token: for worker runtime-proxy and /cf/* endpoints
#   - JWT: for portal-facing endpoints (sessions, billing, settings)
#
# Usage:
#   scripts/smoke_production_authenticated.sh                      # all defaults
#   scripts/smoke_production_authenticated.sh --backend=URL        # override backend
#   scripts/smoke_production_authenticated.sh --worker=URL         # override worker
#   scripts/smoke_production_authenticated.sh --token=TOKEN        # override edge token
#
# Env var overrides:
#   AGENTOS_BACKEND_URL   AGENTOS_WORKER_URL   EDGE_INGEST_TOKEN
#   SMOKE_AUTH_EMAIL      SMOKE_AUTH_PASSWORD

set -euo pipefail

# ── Load .env from repo root so SERVICE_TOKEN / EDGE_INGEST_TOKEN /
# ── DATABASE_URL are picked up without having to export them manually.
# ── Only reads the keys we care about. Safe to re-run in CI where
# ── the file may not exist — skips silently.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
if [ -f "$ENV_FILE" ]; then
  for key in SERVICE_TOKEN EDGE_INGEST_TOKEN AGENTOS_BACKEND_URL AGENTOS_WORKER_URL SMOKE_AUTH_EMAIL SMOKE_AUTH_PASSWORD; do
    # Only set if not already set in the environment (env beats file).
    if [ -z "${!key:-}" ]; then
      value="$(grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
      if [ -n "$value" ]; then
        export "${key}=${value}"
      fi
    fi
  done
fi

# ── Parse args ────────────────────────────────────────────────
BACKEND="${AGENTOS_BACKEND_URL:-https://api.oneshots.co}"
WORKER="${AGENTOS_WORKER_URL:-https://runtime.oneshots.co}"
# Prefer real SERVICE_TOKEN (used by both control-plane and runtime worker
# to validate service-to-service calls) over the legacy EDGE_INGEST_TOKEN
# alias. Fall back to the placeholder only so --help etc. don't crash.
EDGE_TOKEN="${SERVICE_TOKEN:-${EDGE_INGEST_TOKEN:-unset-service-token}}"
EMAIL="${SMOKE_AUTH_EMAIL:-smoke-test@agentos.dev}"
PASSWORD="${SMOKE_AUTH_PASSWORD:-SmokeTest2026!}"

for arg in "$@"; do
  case "$arg" in
    --backend=*) BACKEND="${arg#*=}" ;;
    --worker=*)  WORKER="${arg#*=}" ;;
    --token=*)   EDGE_TOKEN="${arg#*=}" ;;
  esac
done

if [ "$EDGE_TOKEN" = "unset-service-token" ]; then
  printf "\033[33mWARNING: SERVICE_TOKEN not found in env or .env — edge-token checks will fail.\033[0m\n" >&2
fi

RED="\033[31m"; GREEN="\033[32m"; YELLOW="\033[33m"; BOLD="\033[1m"; RESET="\033[0m"
pass=0; fail=0; skip=0; total=0

check() {
  local label="$1" expected="$2" actual="$3"
  total=$((total + 1))
  if [ "$actual" = "$expected" ]; then
    printf "${GREEN}  ✓${RESET} %-45s %s\n" "$label" "$actual"
    pass=$((pass + 1))
  else
    printf "${RED}  ✗${RESET} %-45s %s (expected %s)\n" "$label" "$actual" "$expected"
    fail=$((fail + 1))
  fi
}

skip_check() {
  local label="$1" reason="$2"
  total=$((total + 1))
  skip=$((skip + 1))
  printf "${YELLOW}  ○${RESET} %-45s %s\n" "$label" "$reason"
}

# Helpers for edge-token auth (worker runtime only)
edge_post() {
  local path="$1"; shift
  curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${EDGE_TOKEN}" -X POST "${WORKER}${path}" "$@"
}
jwt_get() {
  curl -s -o /dev/null -w "%{http_code}" -H "$JWT_AUTH" "${BACKEND}${1}"
}
jwt_post() {
  local path="$1"; shift
  curl -s -o /dev/null -w "%{http_code}" -H "$JWT_AUTH" -X POST "${BACKEND}${path}" "$@"
}
cf_post() {
  local path="$1"; shift
  curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${EDGE_TOKEN}" -X POST "${WORKER}${path}" "$@"
}

printf "\n${BOLD}AgentOS Production Smoke Test${RESET}\n"
printf "  Backend: %s\n" "$BACKEND"
printf "  Worker:  %s\n" "$WORKER"
printf "  Auth:    edge-token + JWT (%s)\n\n" "$EMAIL"

# ══════════════════════════════════════════════════════════════
# SECTION 1: Health (unauthenticated)
# ══════════════════════════════════════════════════════════════
printf "${BOLD}Health${RESET}\n"
check "Backend /health" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' "${BACKEND}/health")"
check "Worker /health" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' "${WORKER}/health")"

# ══════════════════════════════════════════════════════════════
# SECTION 2: Auth — obtain JWT for portal endpoints
# ══════════════════════════════════════════════════════════════
printf "\n${BOLD}Auth${RESET}\n"

JWT_TOKEN=$(curl -s -X POST "${BACKEND}/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")

if [ -z "$JWT_TOKEN" ]; then
  JWT_TOKEN=$(curl -s -X POST "${BACKEND}/api/v1/auth/signup" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\",\"name\":\"Smoke\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
fi

JWT_AUTH="Authorization: Bearer ${JWT_TOKEN}"
if [ -n "$JWT_TOKEN" ]; then
  check "JWT auth (login/signup)" "200" "200"
else
  skip_check "JWT auth" "Could not obtain JWT — portal endpoints will be skipped"
fi

# Resolve a real agent name from the authenticated user's org so the
# write-op tests don't hardcode a fixture that may not exist. Prefers
# "my-assistant" (the personal agent auto-created on signup) but
# falls back to the first agent in the list.
SMOKE_AGENT_NAME=""
if [ -n "$JWT_TOKEN" ]; then
  AGENTS_JSON=$(curl -s -H "$JWT_AUTH" "${BACKEND}/api/v1/agents" 2>/dev/null || echo '{}')
  SMOKE_AGENT_NAME=$(printf '%s' "$AGENTS_JSON" | python3 -c 'import sys,json
d = json.load(sys.stdin)
agents = d.get("agents", d) if isinstance(d, dict) else d
names = [a.get("name", "") for a in agents if isinstance(a, dict)]
for pref in ("my-assistant", "agentos"):
    if pref in names:
        print(pref)
        sys.exit(0)
print(names[0] if names else "")
' 2>/dev/null || echo "")
fi
if [ -z "$SMOKE_AGENT_NAME" ]; then
  SMOKE_AGENT_NAME="my-assistant"
fi
printf "  Agent:   %s (resolved from /api/v1/agents)\n" "$SMOKE_AGENT_NAME"

# Resolve the authenticated user's org_id for service-token calls that
# write into org-scoped tables (edge-ingest sessions/turns need a real
# FK to orgs.org_id, not an empty string).
SMOKE_ORG_ID=""
if [ -n "$JWT_TOKEN" ]; then
  ME_JSON=$(curl -s -H "$JWT_AUTH" "${BACKEND}/api/v1/auth/me" 2>/dev/null || echo '{}')
  SMOKE_ORG_ID=$(printf '%s' "$ME_JSON" | python3 -c 'import sys,json
try:
    d = json.load(sys.stdin)
    print(d.get("org_id", ""))
except Exception:
    print("")
' 2>/dev/null || echo "")
fi
printf "  Org:     %s\n" "${SMOKE_ORG_ID:-<unset>}"

# Pre-build payloads once so variable expansion is done in a single
# pass — this avoids the double-escaping maze when embedding shell
# variables in curl -d strings inline with nested "$(...)".
SMOKE_SESSION_ID="smoke-$(date +%s)"
AGENT_RUN_BODY=$(printf '{"agent_name":"%s","input":"Say hi.","channel":"smoke-test","plan":"free"}' "$SMOKE_AGENT_NAME")
INGEST_SESSION_BODY=$(printf '{"session_id":"%s","org_id":"%s","agent_name":"%s","status":"completed","wall_clock_seconds":1,"step_count":1}' "$SMOKE_SESSION_ID" "$SMOKE_ORG_ID" "$SMOKE_AGENT_NAME")
INGEST_TURN_BODY=$(printf '{"session_id":"%s","turn_number":1,"model_used":"smoke","input_tokens":1,"output_tokens":1}' "$SMOKE_SESSION_ID")

check "Edge token auth (control-plane runtime-proxy/agent/run)" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${EDGE_TOKEN}" -X POST "${BACKEND}/api/v1/runtime-proxy/agent/run" -H 'Content-Type: application/json' -d "$AGENT_RUN_BODY")"

check "Edge token auth rejection (wrong token)" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' -X POST "${BACKEND}/api/v1/runtime-proxy/agent/run" -H 'Content-Type: application/json' -d "$AGENT_RUN_BODY")"

# ══════════════════════════════════════════════════════════════
# SECTION 3: Edge Runtime (control-plane runtime-proxy)
# ══════════════════════════════════════════════════════════════
# runtime-proxy lives on the control-plane. It returns 202 Accepted
# for agent/run because the run is dispatched asynchronously to the
# runtime worker via a service binding — the response carries the
# websocket URL the client should poll.
#
# The legacy probes against /tool/call, /llm/infer, /sandbox/exec on
# the worker directly were removed: those paths never existed on the
# runtime worker, the script was hitting a 404.
#
# The route schema requires `input`, not `task` — earlier script
# versions used the worker-side name and hit a ZodError 500.
printf "\n${BOLD}Edge Runtime (control-plane runtime-proxy)${RESET}\n"
check "POST runtime-proxy/agent/run" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${EDGE_TOKEN}" -X POST "${BACKEND}/api/v1/runtime-proxy/agent/run" -H 'Content-Type: application/json' -d "$AGENT_RUN_BODY")"

# ══════════════════════════════════════════════════════════════
# SECTION 4: Edge Ingest (telemetry pipeline)
# ══════════════════════════════════════════════════════════════
# The edge-ingest endpoints live at /sessions + /turns (not /session
# + /events) and the auth middleware checks Authorization: Bearer, so
# the X-Edge-Token header form is rejected before the route can
# inspect it. Using Bearer avoids the pre-auth 401.
#
# `sessions` is org-FK'd — the org_id must resolve to a real row in
# the orgs table or Postgres raises a foreign key violation. We
# resolve the caller's org via /auth/me above. The /turns endpoint
# takes a single turn at a time, not an array of events — earlier
# versions of the script POSTed `{events:[...]}` and hit a ZodError.
printf "\n${BOLD}Edge Ingest (telemetry)${RESET}\n"
if [ -n "$SMOKE_ORG_ID" ]; then
  check "POST edge-ingest/sessions" "200" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BACKEND}/api/v1/edge-ingest/sessions" -H 'Content-Type: application/json' -H "Authorization: Bearer ${EDGE_TOKEN}" -d "$INGEST_SESSION_BODY")"
  check "POST edge-ingest/turns" "200" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BACKEND}/api/v1/edge-ingest/turns" -H 'Content-Type: application/json' -H "Authorization: Bearer ${EDGE_TOKEN}" -d "$INGEST_TURN_BODY")"
else
  skip_check "POST edge-ingest/sessions" "no SMOKE_ORG_ID resolved from /auth/me"
  skip_check "POST edge-ingest/turns"    "no SMOKE_ORG_ID resolved from /auth/me"
fi

# ══════════════════════════════════════════════════════════════
# SECTION 5: CF Bindings (/cf/* on worker)
# ══════════════════════════════════════════════════════════════
printf "\n${BOLD}CF Bindings (worker /cf/*)${RESET}\n"
check "POST /cf/ai/embed" "200" \
  "$(cf_post /cf/ai/embed -H 'Content-Type: application/json' -d '{"texts":["smoke test"]}')"
check "POST /cf/storage/put" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${EDGE_TOKEN}" -H 'Content-Type: text/plain' -X POST "${WORKER}/cf/storage/put?key=smoke/test.txt" -d 'smoke')"
check "GET  /cf/storage/get" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${EDGE_TOKEN}" "${WORKER}/cf/storage/get?key=smoke/test.txt")"
check "POST /cf/rag/ingest" "200" \
  "$(cf_post /cf/rag/ingest -H 'Content-Type: application/json' -d '{"text":"smoke test data for RAG","source":"smoke","org_id":"smoke"}')"
check "POST /cf/rag/query" "200" \
  "$(cf_post /cf/rag/query -H 'Content-Type: application/json' -d '{"query":"smoke","topK":1}')"
check "POST /cf/browse/render (markdown)" "200" \
  "$(cf_post /cf/browse/render -H 'Content-Type: application/json' -d '{"url":"https://example.com","action":"markdown"}')"
check "POST /cf/browse/render (links)" "200" \
  "$(cf_post /cf/browse/render -H 'Content-Type: application/json' -d '{"url":"https://example.com","action":"links"}')"
check "CF auth rejection (no token)" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${WORKER}/cf/ai/embed" -H 'Content-Type: application/json' -d '{"texts":["x"]}')"

# ══════════════════════════════════════════════════════════════
# SECTION 6: Portal API (JWT auth)
# ══════════════════════════════════════════════════════════════
printf "\n${BOLD}Portal API (JWT)${RESET}\n"
if [ -n "$JWT_TOKEN" ]; then
  check "GET /api/v1/agents" "200" "$(jwt_get /api/v1/agents)"
  check "GET /api/v1/plans" "200" "$(jwt_get /api/v1/plans)"
  check "GET /api/v1/tools" "200" "$(jwt_get /api/v1/tools)"
  check "GET /api/v1/sessions" "200" "$(jwt_get /api/v1/sessions)"
  check "GET /api/v1/billing/usage" "200" "$(jwt_get /api/v1/billing/usage)"
  check "GET /api/v1/issues" "200" "$(jwt_get /api/v1/issues)"
  check "GET /api/v1/issues/summary" "200" "$(jwt_get /api/v1/issues/summary)"
  check "GET /api/v1/intelligence/summary" "200" "$(jwt_get /api/v1/intelligence/summary)"
  check "GET /api/v1/intelligence/scores" "200" "$(jwt_get /api/v1/intelligence/scores)"
  check "GET /api/v1/intelligence/analytics" "200" "$(jwt_get /api/v1/intelligence/analytics)"
  check "GET /api/v1/gold-images" "200" "$(jwt_get /api/v1/gold-images)"
  check "GET /api/v1/gold-images/compliance/summary" "200" "$(jwt_get /api/v1/gold-images/compliance/summary)"
  check "GET /api/v1/security/probes" "200" "$(jwt_get /api/v1/security/probes)"
  check "GET /api/v1/security/scans" "200" "$(jwt_get /api/v1/security/scans)"
  check "GET /api/v1/security/risk-profiles" "200" "$(jwt_get /api/v1/security/risk-profiles)"
  check "GET /api/v1/voice/vapi/calls" "200" "$(jwt_get /api/v1/voice/vapi/calls)"
  check "GET /api/v1/voice/all/summary" "200" "$(jwt_get /api/v1/voice/all/summary)"
else
  for ep in agents plans tools sessions billing/usage issues issues/summary \
    intelligence/summary intelligence/scores intelligence/analytics \
    gold-images gold-images/compliance/summary security/probes security/scans \
    security/risk-profiles voice/vapi/calls voice/all/summary; do
    skip_check "GET /api/v1/$ep" "no JWT"
  done
fi

# ══════════════════════════════════════════════════════════════
# SECTION 7: Write Operations (JWT)
# ══════════════════════════════════════════════════════════════
printf "\n${BOLD}Write Operations (JWT)${RESET}\n"
if [ -n "$JWT_TOKEN" ]; then
  # Pre-build the issue-create body so shell escaping doesn't mangle
  # the agent name inside the nested "$(jwt_post ... -d "...")".
  ISSUE_BODY=$(printf '{"title":"smoke","description":"test","agent_name":"%s"}' "$SMOKE_AGENT_NAME")
  check "POST security scan" "200" \
    "$(jwt_post "/api/v1/security/scan/${SMOKE_AGENT_NAME}")"
  check "POST create issue" "200" \
    "$(jwt_post /api/v1/issues -H 'Content-Type: application/json' -d "$ISSUE_BODY")"
  check "POST gold image" "200" \
    "$(jwt_post "/api/v1/gold-images/from-agent/${SMOKE_AGENT_NAME}")"
  check "POST AIVSS calculate" "200" \
    "$(jwt_post /api/v1/security/aivss/calculate -H 'Content-Type: application/json' -d '{"attack_vector":"network","attack_complexity":"low","privileges_required":"none","scope":"unchanged","confidentiality_impact":"high","integrity_impact":"high","availability_impact":"high"}')"
  check "POST compliance check" "200" \
    "$(jwt_post "/api/v1/gold-images/compliance/check/${SMOKE_AGENT_NAME}")"
else
  for op in "security scan" "create issue" "gold image" "AIVSS calculate" "compliance check"; do
    skip_check "POST $op" "no JWT"
  done
fi

# ══════════════════════════════════════════════════════════════
# SECTION 8: Webhooks (unauthenticated + HMAC-verified)
# ══════════════════════════════════════════════════════════════
# Vapi and Tavus webhooks skip JWT auth at the middleware layer
# (they're in public-routes.ts) BUT verify provider-specific HMAC
# signatures in-route. The smoke payloads below carry no signature
# by design, so we expect a 401 "Invalid webhook signature" —
# that's the signal that the hardened signature check is alive.
# A 200 here would actually be the bug worth flagging.
printf "\n${BOLD}Webhooks (signature rejection contract)${RESET}\n"
check "POST Vapi webhook (expect signature rejection)" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BACKEND}/api/v1/voice/vapi/webhook" -H 'Content-Type: application/json' -d '{"message":{"type":"call.started","call":{"id":"smoke-wh"}}}')"
check "POST Tavus webhook (expect signature rejection)" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BACKEND}/api/v1/voice/tavus/webhook" -H 'Content-Type: application/json' -d '{"event":"conversation.started","conversation_id":"smoke-tavus"}')"

# ══════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════
printf "\n${BOLD}Results: ${pass}/${total} passed"
if [ "$fail" -gt 0 ]; then
  printf ", ${RED}${fail} failed${RESET}"
fi
if [ "$skip" -gt 0 ]; then
  printf ", ${YELLOW}${skip} skipped${RESET}"
fi
printf "${RESET}\n\n"

exit "$fail"
