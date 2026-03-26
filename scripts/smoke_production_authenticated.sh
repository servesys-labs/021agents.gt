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

# ── Parse args ────────────────────────────────────────────────
BACKEND="${AGENTOS_BACKEND_URL:-https://backend-production-b174.up.railway.app}"
WORKER="${AGENTOS_WORKER_URL:-https://agentos.servesys.workers.dev}"
EDGE_TOKEN="${EDGE_INGEST_TOKEN:-test-edge-token-2026}"
EMAIL="${SMOKE_AUTH_EMAIL:-smoke-test@agentos.dev}"
PASSWORD="${SMOKE_AUTH_PASSWORD:-SmokeTest2026!}"

for arg in "$@"; do
  case "$arg" in
    --backend=*) BACKEND="${arg#*=}" ;;
    --worker=*)  WORKER="${arg#*=}" ;;
    --token=*)   EDGE_TOKEN="${arg#*=}" ;;
  esac
done

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

check "Edge token auth (worker runtime-proxy)" "200" \
  "$(edge_post /api/v1/runtime-proxy/tool/call -H 'Content-Type: application/json' -d '{"tool":"bash","args":{"command":"echo ok"}}')"

check "Worker runtime auth rejection (wrong token)" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' -X POST "${WORKER}/api/v1/runtime-proxy/tool/call" -H 'Content-Type: application/json' -d '{"tool":"bash","args":{"command":"echo"}}')"

# ══════════════════════════════════════════════════════════════
# SECTION 3: Edge Runtime (worker)
# ══════════════════════════════════════════════════════════════
printf "\n${BOLD}Edge Runtime (worker)${RESET}\n"
check "POST worker runtime-proxy/agent/run" "200" \
  "$(edge_post /api/v1/runtime-proxy/agent/run -H 'Content-Type: application/json' -d '{"agent_name":"research-assistant","task":"Say hi.","channel":"smoke-test"}')"
check "POST worker runtime-proxy/llm/infer" "200" \
  "$(edge_post /api/v1/runtime-proxy/llm/infer -H 'Content-Type: application/json' -d '{"provider":"gmi","model":"deepseek-ai/DeepSeek-V3.2","messages":[{"role":"user","content":"hi"}],"max_tokens":5}')"
check "POST worker runtime-proxy/tool/call" "200" \
  "$(edge_post /api/v1/runtime-proxy/tool/call -H 'Content-Type: application/json' -d '{"tool":"bash","args":{"command":"echo smoke"}}')"
check "POST worker runtime-proxy/sandbox/exec" "200" \
  "$(edge_post /api/v1/runtime-proxy/sandbox/exec -H 'Content-Type: application/json' -d '{"command":"echo sandbox-ok"}')"

# ══════════════════════════════════════════════════════════════
# SECTION 4: Edge Ingest (telemetry pipeline)
# ══════════════════════════════════════════════════════════════
printf "\n${BOLD}Edge Ingest (telemetry)${RESET}\n"
check "POST edge-ingest/session" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BACKEND}/api/v1/edge-ingest/session" -H 'Content-Type: application/json' -H "X-Edge-Token: ${EDGE_TOKEN}" -d '{"session_id":"smoke-'$(date +%s)'","agent_name":"smoke","status":"completed","total_turns":1}')"
check "POST edge-ingest/events" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BACKEND}/api/v1/edge-ingest/events" -H 'Content-Type: application/json' -H "X-Edge-Token: ${EDGE_TOKEN}" -d '{"events":[{"session_id":"smoke","event_type":"test","action":"smoke"}]}')"

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
  check "POST security scan" "200" \
    "$(jwt_post /api/v1/security/scan/code-reviewer)"
  check "POST create issue" "200" \
    "$(jwt_post /api/v1/issues -H 'Content-Type: application/json' -d '{"title":"smoke","description":"test","agent_name":"code-reviewer"}')"
  check "POST gold image" "200" \
    "$(jwt_post /api/v1/gold-images/from-agent/code-reviewer)"
  check "POST AIVSS calculate" "200" \
    "$(jwt_post /api/v1/security/aivss/calculate -H 'Content-Type: application/json' -d '{"attack_vector":"network","attack_complexity":"low","privileges_required":"none","scope":"unchanged","confidentiality_impact":"high","integrity_impact":"high","availability_impact":"high"}')"
  check "POST compliance check" "200" \
    "$(jwt_post /api/v1/gold-images/compliance/check/code-reviewer)"
else
  for op in "security scan" "create issue" "gold image" "AIVSS calculate" "compliance check"; do
    skip_check "POST $op" "no JWT"
  done
fi

# ══════════════════════════════════════════════════════════════
# SECTION 8: Webhooks (unauthenticated)
# ══════════════════════════════════════════════════════════════
printf "\n${BOLD}Webhooks${RESET}\n"
check "POST Vapi webhook" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BACKEND}/api/v1/voice/vapi/webhook" -H 'Content-Type: application/json' -d '{"message":{"type":"call.started","call":{"id":"smoke-wh"}}}')"
check "POST Tavus webhook" "200" \
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
