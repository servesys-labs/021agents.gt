#!/usr/bin/env bash
# Scale bottleneck stress harness (live environment).
#
# Targets known bottleneck classes with per-phase budgets:
#  - Dynamic Worker V8 isolate throughput
#  - Container SDK sandbox throughput
#  - DO-backed runtime invoke throughput
#  - Runtime Hyperdrive-backed eval read path
#  - Control-plane edge-ingest write path (DB/Hyperdrive path)
#  - Optional browser pool pressure (/cf/browse/render)
#
# Required env:
#   E2E_CONTROL_PLANE_URL
#   E2E_RUNTIME_URL
#   E2E_SERVICE_TOKEN
#
# Optional env:
#   E2E_AGENT_NAME (default: agentos)
#   SCALE_REQUESTS (default: 120)
#   SCALE_PARALLEL (default: 20)
#   SCALE_BROWSER_ENABLED (default: 0)

set -euo pipefail

CP_URL="${E2E_CONTROL_PLANE_URL:-}"
RT_URL="${E2E_RUNTIME_URL:-}"
SERVICE_TOKEN="${E2E_SERVICE_TOKEN:-}"
AGENT_NAME="${E2E_AGENT_NAME:-agentos}"
ORG_ID="${E2E_ORG_ID:-}"
SCALE_REQUESTS="${SCALE_REQUESTS:-120}"
SCALE_PARALLEL="${SCALE_PARALLEL:-20}"
SCALE_BROWSER_ENABLED="${SCALE_BROWSER_ENABLED:-0}"

CP_URL="${CP_URL%/}"
RT_URL="${RT_URL%/}"

RED="\033[31m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
RESET="\033[0m"

ok() { echo -e "${GREEN}OK${RESET} $*"; }
info() { echo -e "${CYAN}--${RESET} $*"; }
warn() { echo -e "${YELLOW}WARN${RESET} $*"; }
fail() { echo -e "${RED}FAIL${RESET} $*"; exit 1; }
phase_fail() { echo -e "${RED}FAIL${RESET} $*"; PHASE_FAILURES=$((PHASE_FAILURES + 1)); }

require_env() {
  [[ -n "$CP_URL" ]] || fail "Missing E2E_CONTROL_PLANE_URL"
  [[ -n "$RT_URL" ]] || fail "Missing E2E_RUNTIME_URL"
  [[ -n "$SERVICE_TOKEN" ]] || fail "Missing E2E_SERVICE_TOKEN"
}

curl_probe() {
  local method="$1"
  local url="$2"
  local payload="${3:-}"
  if [[ "$method" == "GET" ]]; then
    curl -sS -o /dev/null -w "%{http_code} %{time_total}" \
      -H "Authorization: Bearer ${SERVICE_TOKEN}" \
      "$url" || echo "000 99.0"
  else
    curl -sS -o /dev/null -w "%{http_code} %{time_total}" \
      -X "$method" \
      -H "Authorization: Bearer ${SERVICE_TOKEN}" \
      -H "X-Edge-Token: ${SERVICE_TOKEN}" \
      -H "Content-Type: application/json" \
      --data-binary "$payload" \
      "$url" || echo "000 99.0"
  fi
}

run_phase() {
  local name="$1"
  local method="$2"
  local url="$3"
  local payload_template="$4"
  local expected_status="$5"
  local max_failure_rate="$6"
  local max_p95_s="$7"
  local req_count="$8"
  local parallel="$9"

  info "Phase ${name}: requests=${req_count}, parallel=${parallel}"
  local tmpdir
  tmpdir="$(mktemp -d)"
  local i
  for i in $(seq 1 "$req_count"); do
    (
      local payload
      payload="$(printf '%s' "$payload_template" | sed "s/__IDX__/${i}/g")"
      local line
      line="$(curl_probe "$method" "$url" "$payload")"
      printf '%s\n' "$line" > "${tmpdir}/${i}.txt"
    ) &
    while [[ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$parallel" ]]; do
      sleep 0.05
    done
  done
  wait

  local stats
  stats="$(python3 - "$tmpdir" "$req_count" "$expected_status" <<'PY'
import os, sys, statistics
tmpdir = sys.argv[1]
n = int(sys.argv[2])
expected = sys.argv[3]
statuses = []
latencies = []
for i in range(1, n + 1):
    p = os.path.join(tmpdir, f"{i}.txt")
    try:
      raw = open(p, "r", encoding="utf-8").read().strip().split()
      status = raw[0] if raw else "000"
      latency = float(raw[1]) if len(raw) > 1 else 99.0
    except Exception:
      status, latency = "000", 99.0
    statuses.append(status)
    latencies.append(latency)
ok = sum(1 for s in statuses if s == expected)
fail = n - ok
fr = fail / n if n else 1.0
lat_sorted = sorted(latencies)
def pct(arr, p):
    if not arr: return 99.0
    idx = min(len(arr)-1, max(0, int(round((p/100)*(len(arr)-1)))))
    return arr[idx]
p50 = pct(lat_sorted, 50)
p95 = pct(lat_sorted, 95)
p99 = pct(lat_sorted, 99)
status_counts = {}
for s in statuses:
    status_counts[s] = status_counts.get(s, 0) + 1
print(ok, fail, fr, p50, p95, p99, status_counts.get("429",0), status_counts.get("500",0), status_counts.get("503",0), status_counts.get("524",0), status_counts.get("000",0))
PY
)"
  rm -rf "$tmpdir"

  local ok_count fail_count failure_rate p50 p95 p99 c429 c500 c503 c524 c000
  read -r ok_count fail_count failure_rate p50 p95 p99 c429 c500 c503 c524 c000 <<<"$stats"

  echo "   result: ok=${ok_count}/${req_count} fail=${fail_count} failure_rate=${failure_rate} p50=${p50}s p95=${p95}s p99=${p99}s"
  echo "   status-signatures: 429=${c429} 500=${c500} 503=${c503} 524=${c524} net=${c000}"

  local pass_failrate pass_p95
  pass_failrate="$(python3 - "$failure_rate" "$max_failure_rate" <<'PY'
import sys
print("1" if float(sys.argv[1]) <= float(sys.argv[2]) else "0")
PY
)"
  pass_p95="$(python3 - "$p95" "$max_p95_s" <<'PY'
import sys
print("1" if float(sys.argv[1]) <= float(sys.argv[2]) else "0")
PY
)"
  if [[ "$pass_failrate" != "1" ]]; then
    phase_fail "${name}: failure_rate ${failure_rate} exceeded ${max_failure_rate}"
    return 0
  fi
  if [[ "$pass_p95" != "1" ]]; then
    phase_fail "${name}: p95 ${p95}s exceeded ${max_p95_s}s"
    return 0
  fi
  ok "${name} within SLO budget"
}

require_env
RUN_TAG="scale-$(date +%s)-$RANDOM"
PHASE_FAILURES=0
echo "Running scale bottleneck tests"
echo "  control-plane: ${CP_URL}"
echo "  runtime:       ${RT_URL}"
echo "  agent:         ${AGENT_NAME}"
echo "  org_id:        ${ORG_ID:-<unset>}"
echo "  requests:      ${SCALE_REQUESTS}"
echo "  parallel:      ${SCALE_PARALLEL}"
echo "  run tag:       ${RUN_TAG}"

# Sanity health checks first.
info "Preflight health checks"
HC="$(curl -sS -o /dev/null -w "%{http_code}" "${CP_URL}/api/v1/health/detailed")"
[[ "$HC" == "200" ]] || fail "control-plane health/detailed not healthy (${HC})"
HR="$(curl -sS -o /dev/null -w "%{http_code}" "${RT_URL}/health")"
[[ "$HR" == "200" ]] || fail "runtime /health not healthy (${HR})"
ok "preflight healthy"

# 1) Dynamic workers V8 isolates
run_phase \
  "dynamic-worker-js-isolate" \
  "POST" \
  "${RT_URL}/cf/sandbox/exec" \
  '{"language":"javascript","code":"console.log(\"bottleneck_js___IDX__\")","timeoutMs":10000}' \
  "200" \
  "0.15" \
  "2.5" \
  "$SCALE_REQUESTS" \
  "$SCALE_PARALLEL"

# 2) Container SDK python/bas h path (using bash here to avoid package variance)
run_phase \
  "container-sandbox-bash" \
  "POST" \
  "${RT_URL}/cf/sandbox/exec" \
  '{"language":"bash","code":"echo bottleneck_bash___IDX__","timeoutMs":12000}' \
  "200" \
  "0.20" \
  "4.0" \
  "$SCALE_REQUESTS" \
  "$SCALE_PARALLEL"

# 3) DO + workflow invoke acceptance path
run_phase \
  "do-runtime-invoke" \
  "POST" \
  "${RT_URL}/api/v1/runtime-proxy/runnable/invoke" \
  "{\"agent_name\":\"${AGENT_NAME}\",\"task\":\"Reply with bottleneck_ok___IDX__\",\"channel\":\"scale-burst\",\"channel_user_id\":\"scale-user-__IDX__\"}" \
  "202" \
  "0.10" \
  "1.5" \
  "$SCALE_REQUESTS" \
  "$SCALE_PARALLEL"

# 4) Hyperdrive read pressure through eval runs endpoint
run_phase \
  "hyperdrive-eval-runs-read" \
  "GET" \
  "${RT_URL}/api/v1/eval/runs?agent_name=${AGENT_NAME}&limit=20" \
  '' \
  "200" \
  "0.10" \
  "1.2" \
  "$SCALE_REQUESTS" \
  "$SCALE_PARALLEL"

# 5) Control-plane ingest write pressure (DB path)
if [[ -n "$ORG_ID" ]]; then
  run_phase \
    "control-plane-edge-ingest-writes" \
    "POST" \
    "${CP_URL}/api/v1/edge-ingest/sessions" \
    "{\"session_id\":\"${RUN_TAG}-__IDX__\",\"org_id\":\"${ORG_ID}\",\"project_id\":\"\",\"agent_name\":\"scale-probe\",\"status\":\"completed\",\"input_text\":\"x\",\"output_text\":\"y\",\"step_count\":1,\"action_count\":1,\"wall_clock_seconds\":1,\"cost_total_usd\":0.0001}" \
    "200" \
    "0.10" \
    "1.5" \
    "$SCALE_REQUESTS" \
    "$SCALE_PARALLEL"
else
  warn "Skipping control-plane edge-ingest write pressure (set E2E_ORG_ID to satisfy sessions FK)"
fi

if [[ "$SCALE_BROWSER_ENABLED" == "1" ]]; then
  # 6) Optional browser pool pressure (heavier endpoint; fewer requests recommended)
  browser_requests=$(( SCALE_REQUESTS < 40 ? SCALE_REQUESTS : 40 ))
  browser_parallel=$(( SCALE_PARALLEL < 8 ? SCALE_PARALLEL : 8 ))
  run_phase \
    "browser-render-pool" \
    "POST" \
    "${RT_URL}/cf/browse/render" \
    '{"url":"https://example.com","action":"markdown"}' \
    "200" \
    "0.30" \
    "8.0" \
    "$browser_requests" \
    "$browser_parallel"
else
  warn "Skipping browser pool pressure test (SCALE_BROWSER_ENABLED=${SCALE_BROWSER_ENABLED})"
fi

if [[ "$PHASE_FAILURES" -gt 0 ]]; then
  fail "Scale bottleneck tests completed with ${PHASE_FAILURES} failing phase(s)"
fi
ok "Scale bottleneck tests passed"
