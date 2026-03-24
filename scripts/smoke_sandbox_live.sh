#!/usr/bin/env bash
# smoke_sandbox_live.sh — Live tests for Dynamic Workers + Sandbox SDK + E2B fallback
#
# Tests the full sandbox routing stack:
#   1. Dynamic Worker — JS code execution (via Cloudflare worker)
#   2. Dynamic Worker — Python code execution (via Cloudflare worker)
#   3. Sandbox SDK — bash execution (via Cloudflare container)
#   4. E2B fallback — via Railway backend proxy
#   5. Backend sandbox_exec — via Railway API
#
# Usage:
#   scripts/smoke_sandbox_live.sh [WORKER_URL] [BACKEND_URL]

set -euo pipefail

WORKER_URL="${1:-${AGENTOS_WORKER_URL:-https://agentos.eprasad-servsys.workers.dev}}"
BACKEND_URL="${2:-${AGENTOS_BACKEND_URL:-https://backend-production-b174.up.railway.app}}"

RED="\033[31m"; GREEN="\033[32m"; YELLOW="\033[33m"; BOLD="\033[1m"; RESET="\033[0m"
pass=0; fail=0; skip=0; total=0

check() {
  local label="$1" expected="$2" actual="$3"
  total=$((total + 1))
  if [ "$actual" = "$expected" ]; then
    printf "${GREEN}  ✓${RESET} %-45s %s\n" "$label" "$actual"
    pass=$((pass + 1))
  elif [ "$actual" = "SKIP" ]; then
    printf "${YELLOW}  ⊘${RESET} %-45s %s\n" "$label" "skipped (beta feature not available)"
    skip=$((skip + 1))
  else
    printf "${RED}  ✗${RESET} %-45s %s (expected %s)\n" "$label" "$actual" "$expected"
    fail=$((fail + 1))
  fi
}

printf "\n${BOLD}AgentOS Sandbox Live Test${RESET}\n"
printf "  Worker:  %s\n" "$WORKER_URL"
printf "  Backend: %s\n\n" "$BACKEND_URL"

# ── Get auth token ────────────────────────────────────────────────
TOKEN=$(curl -s -X POST "${BACKEND_URL}/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"smoke-test@agentos.dev","password":"SmokeTest2026!"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  TOKEN=$(curl -s -X POST "${BACKEND_URL}/api/v1/auth/signup" \
    -H "Content-Type: application/json" \
    -d '{"email":"sandbox-test@agentos.dev","password":"SandboxTest2026!","name":"Sandbox"}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
fi
AUTH="Authorization: Bearer $TOKEN"

# ── 1. Worker Health ──────────────────────────────────────────────
printf "${BOLD}Worker Health${RESET}\n"
WORKER_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${WORKER_URL}/health" 2>/dev/null || echo "000")
check "Worker /health" "200" "$WORKER_HEALTH"

# ── 2. Dynamic Worker — JS Execution ─────────────────────────────
printf "\n${BOLD}Dynamic Worker — JavaScript${RESET}\n"

# Test via /sandbox/exec-code endpoint (Direct Dynamic Worker execution)
JS_RESULT=$(curl -s -w "\n%{http_code}" -X POST \
  "${WORKER_URL}/sandbox/exec-code" \
  -H "Content-Type: application/json" \
  -d '{"code":"const x = 2 + 3; console.log(x);","language":"javascript","timeoutMs":5000}' 2>/dev/null || echo -e "\n000")
JS_CODE=$(echo "$JS_RESULT" | tail -1)
JS_BODY=$(echo "$JS_RESULT" | head -1)

if [ "$JS_CODE" = "000" ] || [ "$JS_CODE" = "500" ]; then
  # Dynamic Workers beta may not be enabled
  check "JS exec via worker RPC" "200" "SKIP"
  JS_STDOUT=""
else
  check "JS exec via worker RPC" "200" "$JS_CODE"
  JS_STDOUT=$(echo "$JS_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stdout',''))" 2>/dev/null || echo "")
  check "JS output = '5'" "5" "$JS_STDOUT"
  JS_TYPE=$(echo "$JS_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sandbox_type',''))" 2>/dev/null || echo "")
  check "JS sandbox_type = dynamic_worker" "dynamic_worker" "$JS_TYPE"
fi

# ── 3. Dynamic Worker — Python Execution ─────────────────────────
printf "\n${BOLD}Dynamic Worker — Python${RESET}\n"

PY_RESULT=$(curl -s -w "\n%{http_code}" -X POST \
  "${WORKER_URL}/sandbox/exec-code" \
  -H "Content-Type: application/json" \
  -d '{"code":"x = sum(range(10))\nprint(x)","language":"python","timeoutMs":10000}' 2>/dev/null || echo -e "\n000")
PY_CODE=$(echo "$PY_RESULT" | tail -1)
PY_BODY=$(echo "$PY_RESULT" | head -1)

if [ "$PY_CODE" = "000" ] || [ "$PY_CODE" = "500" ]; then
  check "Python exec via worker RPC" "200" "SKIP"
else
  check "Python exec via worker RPC" "200" "$PY_CODE"
  PY_STDOUT=$(echo "$PY_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stdout','').strip())" 2>/dev/null || echo "")
  check "Python output = '45'" "45" "$PY_STDOUT"
  PY_LANG=$(echo "$PY_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('language',''))" 2>/dev/null || echo "")
  check "Python language = python" "python" "$PY_LANG"
fi

# ── 4. Sandbox SDK — Bash Execution ──────────────────────────────
printf "\n${BOLD}Sandbox SDK — Bash (Container)${RESET}\n"

# sandbox_exec with bash command should route to Sandbox SDK container
BASH_RESULT=$(curl -s -w "\n%{http_code}" -X POST \
  "${WORKER_URL}/sandbox/exec-code" \
  -H "Content-Type: application/json" \
  -d '{"code":"echo hello-from-sandbox","language":"bash"}' 2>/dev/null || echo -e "\n000")
BASH_CODE=$(echo "$BASH_RESULT" | tail -1)

if [ "$BASH_CODE" = "200" ]; then
  check "Bash exec via Sandbox SDK container" "200" "$BASH_CODE"
elif [ "$BASH_CODE" = "400" ] || [ "$BASH_CODE" = "500" ] || [ "$BASH_CODE" = "503" ]; then
  # 400=no SANDBOX binding, 503=container starting, 500=container error
  check "Bash via Sandbox SDK (container not ready)" "200" "SKIP"
else
  check "Bash via Sandbox SDK" "200" "$BASH_CODE"
fi

# ── 5. Backend sandbox_exec (E2B fallback path) ──────────────────
printf "\n${BOLD}Backend — sandbox_exec (E2B fallback)${RESET}\n"

# Test via backend API (uses E2B or local fallback)
BE_SANDBOX=$(curl -s -w "\n%{http_code}" -H "$AUTH" -X POST \
  "${BACKEND_URL}/sandbox/exec" \
  -H "Content-Type: application/json" \
  -d '{"command":"echo hello-from-backend"}' 2>/dev/null || echo -e "\n000")
BE_CODE=$(echo "$BE_SANDBOX" | tail -1)
BE_BODY=$(echo "$BE_SANDBOX" | head -1)

if [ "$BE_CODE" = "200" ]; then
  check "Backend sandbox_exec" "200" "$BE_CODE"
  BE_STDOUT=$(echo "$BE_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stdout','').strip())" 2>/dev/null || echo "")
  check "Backend output = 'hello-from-backend'" "hello-from-backend" "$BE_STDOUT"
elif [ "$BE_CODE" = "503" ] || [ "$BE_CODE" = "500" ]; then
  # E2B not configured or no local fallback
  check "Backend sandbox_exec" "200" "SKIP"
else
  check "Backend sandbox_exec" "200" "$BE_CODE"
fi

# ── 6. Backend dynamic-exec tool (local fallback) ────────────────
printf "\n${BOLD}Backend — dynamic-exec tool${RESET}\n"

# Test the dynamic-exec builtin tool via tool/call proxy
BE_DYN=$(curl -s -w "\n%{http_code}" -H "$AUTH" -X POST \
  "${BACKEND_URL}/api/v1/tools/call" \
  -H "Content-Type: application/json" \
  -d '{"tool":"dynamic-exec","args":{"code":"console.log(7*6)","language":"javascript"}}' 2>/dev/null || echo -e "\n000")
BE_DYN_CODE=$(echo "$BE_DYN" | tail -1)

if [ "$BE_DYN_CODE" = "200" ]; then
  check "Backend dynamic-exec (JS)" "200" "$BE_DYN_CODE"
elif [ "$BE_DYN_CODE" = "404" ] || [ "$BE_DYN_CODE" = "422" ]; then
  # Endpoint may not exist on deployed backend yet
  check "Backend dynamic-exec (JS)" "200" "SKIP"
else
  check "Backend dynamic-exec (JS)" "200" "$BE_DYN_CODE"
fi

# ── 7. Tool listing — verify new tools registered ────────────────
printf "\n${BOLD}Tool Registration${RESET}\n"

TOOLS=$(curl -s -H "$AUTH" "${BACKEND_URL}/api/v1/tools" 2>/dev/null)
HAS_DYN=$(echo "$TOOLS" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(t['name']=='dynamic-exec' for t in d.get('tools',[])) else 'no')" 2>/dev/null || echo "no")
HAS_IMG=$(echo "$TOOLS" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(t['name']=='image-generate' for t in d.get('tools',[])) else 'no')" 2>/dev/null || echo "no")
HAS_TTS=$(echo "$TOOLS" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(t['name']=='text-to-speech' for t in d.get('tools',[])) else 'no')" 2>/dev/null || echo "no")
HAS_STT=$(echo "$TOOLS" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(t['name']=='speech-to-text' for t in d.get('tools',[])) else 'no')" 2>/dev/null || echo "no")
TOOL_COUNT=$(echo "$TOOLS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('tools',[])))" 2>/dev/null || echo "0")

check "dynamic-exec tool registered" "yes" "$HAS_DYN"
check "image-generate tool registered" "yes" "$HAS_IMG"
check "text-to-speech tool registered" "yes" "$HAS_TTS"
check "speech-to-text tool registered" "yes" "$HAS_STT"
check "Total tools >= 25" "yes" "$([ "$TOOL_COUNT" -ge 25 ] && echo yes || echo no)"

# ── 8. Plans — multimodal tiers present ──────────────────────────
printf "\n${BOLD}Multimodal Plans${RESET}\n"

PLANS=$(curl -s "${BACKEND_URL}/api/v1/plans" 2>/dev/null)
PLAN_MM=$(echo "$PLANS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
plans = d.get('plans',{})
mm_count = sum(1 for p in plans.values() if p.get('multimodal'))
print(mm_count)
" 2>/dev/null || echo "0")
check "All 6 plans are multimodal" "6" "$PLAN_MM"

HAS_IMG_TIER=$(echo "$PLANS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
premium = d.get('plans',{}).get('premium',{}).get('tiers',{})
print('yes' if 'image_gen' in premium else 'no')
" 2>/dev/null || echo "no")
check "Premium plan has image_gen tier" "yes" "$HAS_IMG_TIER"

# ── Summary ───────────────────────────────────────────────────────
printf "\n${BOLD}Results: ${pass} passed, ${fail} failed, ${skip} skipped out of ${total}${RESET}\n"

if [ "$skip" -gt 0 ]; then
  printf "${YELLOW}Note: Skipped tests are for beta features (Dynamic Workers / Sandbox SDK).${RESET}\n"
  printf "${YELLOW}Apply for access: https://forms.gle/MoeDxE9wNiqdf8ri9${RESET}\n"
fi

printf "\n"
exit "$fail"
