#!/usr/bin/env bash
# smoke_production_authenticated.sh — 25-check production smoke test
#
# Usage:
#   scripts/smoke_production_authenticated.sh [URL] [EMAIL] [PASSWORD]
#
# Defaults:
#   URL:      $AGENTOS_BACKEND_URL or https://backend-production-b174.up.railway.app
#   EMAIL:    $SMOKE_AUTH_EMAIL    or smoke-test@agentos.dev
#   PASSWORD: $SMOKE_AUTH_PASSWORD or SmokeTest2026!

set -euo pipefail

BACKEND="${1:-${AGENTOS_BACKEND_URL:-https://backend-production-b174.up.railway.app}}"
EMAIL="${2:-${SMOKE_AUTH_EMAIL:-smoke-test@agentos.dev}}"
PASSWORD="${3:-${SMOKE_AUTH_PASSWORD:-SmokeTest2026!}}"

RED="\033[31m"; GREEN="\033[32m"; BOLD="\033[1m"; RESET="\033[0m"
pass=0; fail=0; total=0

check() {
  local label="$1" expected="$2" actual="$3"
  total=$((total + 1))
  if [ "$actual" = "$expected" ]; then
    printf "${GREEN}  ✓${RESET} %-35s %s\n" "$label" "$actual"
    pass=$((pass + 1))
  else
    printf "${RED}  ✗${RESET} %-35s %s (expected %s)\n" "$label" "$actual" "$expected"
    fail=$((fail + 1))
  fi
}

get_code() {
  curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "${BACKEND}${1}"
}

post_code() {
  local path="$1"; shift
  curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" -X POST "${BACKEND}${path}" "$@"
}

printf "\n${BOLD}AgentOS Production Smoke Test${RESET}\n"
printf "  Backend: %s\n" "$BACKEND"
printf "  Auth:    %s\n\n" "$EMAIL"

# ── Health (unauthenticated) ──────────────────────────────────
printf "${BOLD}Health${RESET}\n"
check "GET /api/v1/health" "200" "$(curl -s -o /dev/null -w '%{http_code}' "${BACKEND}/api/v1/health")"

# ── Auth ──────────────────────────────────────────────────────
printf "\n${BOLD}Auth${RESET}\n"

# Try login first, fallback to signup
TOKEN=$(curl -s -X POST "${BACKEND}/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  TOKEN=$(curl -s -X POST "${BACKEND}/api/v1/auth/signup" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\",\"name\":\"Smoke\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
fi

if [ -z "$TOKEN" ]; then
  printf "${RED}  ✗ Could not obtain auth token${RESET}\n"
  exit 1
fi
AUTH="Authorization: Bearer $TOKEN"
check "Auth token obtained" "200" "200"

# ── GET Endpoints (authenticated) ─────────────────────────────
printf "\n${BOLD}GET Endpoints${RESET}\n"
check "GET /api/v1/agents"                          "200" "$(get_code /api/v1/agents)"
check "GET /api/v1/plans"                           "200" "$(get_code /api/v1/plans)"
check "GET /api/v1/tools"                           "200" "$(get_code /api/v1/tools)"
check "GET /api/v1/sessions"                        "200" "$(get_code /api/v1/sessions)"
check "GET /api/v1/billing/usage"                   "200" "$(get_code /api/v1/billing/usage)"
check "GET /api/v1/issues"                          "200" "$(get_code /api/v1/issues)"
check "GET /api/v1/issues/summary"                  "200" "$(get_code /api/v1/issues/summary)"
check "GET /api/v1/intelligence/summary"            "200" "$(get_code /api/v1/intelligence/summary)"
check "GET /api/v1/intelligence/scores"             "200" "$(get_code /api/v1/intelligence/scores)"
check "GET /api/v1/intelligence/analytics"          "200" "$(get_code /api/v1/intelligence/analytics)"
check "GET /api/v1/gold-images"                     "200" "$(get_code /api/v1/gold-images)"
check "GET /api/v1/gold-images/compliance/summary"  "200" "$(get_code /api/v1/gold-images/compliance/summary)"
check "GET /api/v1/security/probes"                 "200" "$(get_code /api/v1/security/probes)"
check "GET /api/v1/security/scans"                  "200" "$(get_code /api/v1/security/scans)"
check "GET /api/v1/security/risk-profiles"          "200" "$(get_code /api/v1/security/risk-profiles)"
check "GET /api/v1/security/risk-trends/code-reviewer" "200" "$(get_code /api/v1/security/risk-trends/code-reviewer)"
check "GET /api/v1/voice/vapi/calls"                "200" "$(get_code /api/v1/voice/vapi/calls)"
check "GET /api/v1/voice/all/summary"               "200" "$(get_code /api/v1/voice/all/summary)"

# ── POST/Write Operations ─────────────────────────────────────
printf "\n${BOLD}Write Operations${RESET}\n"
check "POST security scan"       "200" "$(post_code /api/v1/security/scan/code-reviewer)"
check "POST create issue"        "200" "$(post_code /api/v1/issues -H 'Content-Type: application/json' -d '{"title":"smoke","description":"test","agent_name":"code-reviewer"}')"
check "POST gold image"          "200" "$(post_code /api/v1/gold-images/from-agent/code-reviewer)"
check "POST AIVSS calculate"     "200" "$(post_code /api/v1/security/aivss/calculate -H 'Content-Type: application/json' -d '{"attack_vector":"network","attack_complexity":"low","privileges_required":"none","scope":"unchanged","confidentiality_impact":"high","integrity_impact":"high","availability_impact":"high"}')"
check "POST compliance check"    "200" "$(post_code /api/v1/gold-images/compliance/check/code-reviewer)"

# ── Webhooks (unauthenticated, signature-verified) ────────────
printf "\n${BOLD}Webhooks${RESET}\n"
check "POST Vapi webhook"  "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BACKEND}/api/v1/voice/vapi/webhook" -H 'Content-Type: application/json' -d '{"message":{"type":"call.started","call":{"id":"smoke-wh"}}}')"
check "POST Tavus webhook" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BACKEND}/api/v1/voice/tavus/webhook" -H 'Content-Type: application/json' -d '{"event":"conversation.started","conversation_id":"smoke-tavus"}')"

# ── Summary ───────────────────────────────────────────────────
printf "\n${BOLD}Results: ${pass}/${total} passed"
if [ "$fail" -gt 0 ]; then
  printf ", ${RED}${fail} failed${RESET}"
fi
printf "${RESET}\n\n"

exit "$fail"
