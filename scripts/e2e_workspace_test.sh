#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# E2E Workspace Tests — verify control-plane + runtime R2 integration
#
# Requires:
#   API_BASE  — control-plane base URL  (default: https://api.oneshots.co/api/v1)
#   API_TOKEN — valid bearer token       (required)
#   AGENT     — agent name to test with  (default: e2e-workspace-test)
#   RUNTIME_BASE — runtime base URL      (optional, for /cf/storage auth test)
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

API_BASE="${API_BASE:-https://api.oneshots.co/api/v1}"
RUNTIME_BASE="${RUNTIME_BASE:-https://runtime.oneshots.co}"
AGENT="${AGENT:-e2e-workspace-test}"
AUTH="Authorization: Bearer ${API_TOKEN:?API_TOKEN is required}"

passed=0
failed=0
total=0

function run_test() {
  local name="$1"
  total=$((total + 1))
  echo -n "  [$total] $name ... "
}

function pass() {
  passed=$((passed + 1))
  echo "PASS"
}

function fail() {
  failed=$((failed + 1))
  echo "FAIL${1:+ — $1}"
}

echo "══════════════════════════════════════════════════════════════"
echo " E2E Workspace Tests"
echo " API_BASE: $API_BASE"
echo " AGENT:    $AGENT"
echo "══════════════════════════════════════════════════════════════"
echo ""

# ── Test 1: Control-plane workspace list returns 200 ─────────────────

run_test "Control-plane workspace list returns 200"
status=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "$AUTH" \
  "${API_BASE}/workspace/files?agent_name=${AGENT}")
if [ "$status" = "200" ]; then
  pass
else
  fail "got HTTP $status"
fi

# ── Test 2: File create via control-plane ────────────────────────────

TEST_PATH="e2e-test-$(date +%s).txt"
TEST_CONTENT="Hello from E2E test at $(date -Iseconds)"

run_test "File create via control-plane"
create_resp=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"agent_name\":\"${AGENT}\",\"path\":\"${TEST_PATH}\",\"content\":\"${TEST_CONTENT}\"}" \
  "${API_BASE}/workspace/files/create")
create_status=$(echo "$create_resp" | tail -1)
create_body=$(echo "$create_resp" | sed '$d')
if [ "$create_status" = "200" ]; then
  pass
else
  fail "got HTTP $create_status: $create_body"
fi

# ── Test 3: File read via control-plane returns correct content ──────

run_test "File read via control-plane returns correct content"
read_resp=$(curl -s -w "\n%{http_code}" \
  -H "$AUTH" \
  "${API_BASE}/workspace/files/read?agent_name=${AGENT}&path=${TEST_PATH}")
read_status=$(echo "$read_resp" | tail -1)
read_body=$(echo "$read_resp" | sed '$d')
if [ "$read_status" = "200" ]; then
  # Check that content is in the response
  if echo "$read_body" | grep -q "Hello from E2E test"; then
    pass
  else
    fail "content mismatch"
  fi
else
  fail "got HTTP $read_status"
fi

# ── Test 4: File delete via control-plane ────────────────────────────

run_test "File delete via control-plane"
del_status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X DELETE \
  -H "$AUTH" \
  "${API_BASE}/workspace/files?agent_name=${AGENT}&path=${TEST_PATH}")
if [ "$del_status" = "200" ]; then
  # Verify file is gone
  verify_status=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "$AUTH" \
    "${API_BASE}/workspace/files/read?agent_name=${AGENT}&path=${TEST_PATH}")
  if [ "$verify_status" = "404" ]; then
    pass
  else
    fail "file still exists after delete (HTTP $verify_status)"
  fi
else
  fail "got HTTP $del_status"
fi

# ── Test 5: Unauthenticated /cf/storage/get returns 401 ─────────────

run_test "Unauthenticated /cf/storage/get returns 401"
storage_status=$(curl -s -o /dev/null -w "%{http_code}" \
  "${RUNTIME_BASE}/cf/storage/get?key=workspaces/test/test/u/shared/files/test.txt")
if [ "$storage_status" = "401" ]; then
  pass
else
  fail "got HTTP $storage_status (expected 401)"
fi

# ── Test 6: Path traversal returns 400 ──────────────────────────────

run_test "Path traversal (../../../etc/passwd) returns 400"
traversal_status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"agent_name\":\"${AGENT}\",\"path\":\"../../../etc/passwd\",\"content\":\"pwned\"}" \
  "${API_BASE}/workspace/files/create")
if [ "$traversal_status" = "400" ]; then
  pass
else
  fail "got HTTP $traversal_status (expected 400)"
fi

# ── Summary ──────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════════════════════"
echo " Results: $passed/$total passed, $failed failed"
echo "══════════════════════════════════════════════════════════════"

if [ "$failed" -gt 0 ]; then
  exit 1
fi
