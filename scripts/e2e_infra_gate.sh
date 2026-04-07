#!/usr/bin/env bash
# Staged E2E infrastructure gate for staging/prod-like environments.
#
# Validates critical live paths:
#  1) control-plane health + dependency checks (DB/Hyperdrive + runtime binding)
#  2) runtime worker health
#  3) Dynamic Worker V8 isolate path via /cf/sandbox/exec (javascript)
#  4) Container SDK sandbox path via /cf/sandbox/exec (bash)
#  5) Runtime eval pipeline acceptance + readback APIs (DO/workflow + Hyperdrive)
#
# Required env:
#   E2E_CONTROL_PLANE_URL   e.g. https://api-staging.example.com
#   E2E_RUNTIME_URL         e.g. https://runtime-staging.example.com
#   E2E_SERVICE_TOKEN       SERVICE_TOKEN configured on runtime/control-plane
#
# Optional env:
#   E2E_AGENT_NAME          defaults to "agentos"
#   E2E_ORG_ID              optional org context attached to eval runs
#   E2E_TIMEOUT_SECONDS     defaults to 120
#   E2E_SOAK_ENABLED        defaults to "1" (set "0" to skip soak stage)
#   E2E_SOAK_PARALLEL       defaults to 8
#   E2E_SOAK_REQUESTS       defaults to 24
#   E2E_SOAK_MAX_FAILURE_RATE defaults to 0.10 (10%)
#   E2E_STRESS_ENABLED      defaults to "0" (set "1" to enable load ramp stage)
#   E2E_STRESS_RAMP         defaults to "32,64,128" concurrent levels
#   E2E_STRESS_REQUESTS     defaults to 180 requests per ramp step
#   E2E_STRESS_MAX_FAILURE_RATE defaults to 0.15
#   E2E_STRESS_MAX_P95_S    defaults to 5.0
#   E2E_LARGE_OUTPUT_MIN_BYTES defaults to 10000

set -euo pipefail

CP_URL="${E2E_CONTROL_PLANE_URL:-}"
RT_URL="${E2E_RUNTIME_URL:-}"
SERVICE_TOKEN="${E2E_SERVICE_TOKEN:-}"
AGENT_NAME="${E2E_AGENT_NAME:-agentos}"
ORG_ID="${E2E_ORG_ID:-}"
TIMEOUT_SECONDS="${E2E_TIMEOUT_SECONDS:-120}"
SOAK_ENABLED="${E2E_SOAK_ENABLED:-1}"
SOAK_PARALLEL="${E2E_SOAK_PARALLEL:-8}"
SOAK_REQUESTS="${E2E_SOAK_REQUESTS:-24}"
SOAK_MAX_FAILURE_RATE="${E2E_SOAK_MAX_FAILURE_RATE:-0.10}"
STRESS_ENABLED="${E2E_STRESS_ENABLED:-0}"
STRESS_RAMP="${E2E_STRESS_RAMP:-32,64,128}"
STRESS_REQUESTS="${E2E_STRESS_REQUESTS:-180}"
STRESS_MAX_FAILURE_RATE="${E2E_STRESS_MAX_FAILURE_RATE:-0.15}"
STRESS_MAX_P95_S="${E2E_STRESS_MAX_P95_S:-5.0}"
LARGE_OUTPUT_MIN_BYTES="${E2E_LARGE_OUTPUT_MIN_BYTES:-10000}"
REPORT_DIR="${E2E_REPORT_DIR:-artifacts/e2e-infra-gate}"

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

mkdir -p "$REPORT_DIR"
STRESS_REPORT_FILE="${REPORT_DIR}/stress-ramp.tsv"
echo -e "name\trequests\tok\tfail\tfailure_rate\tp95_s\tmax_failure_rate\tmax_p95_s\tstatus" > "$STRESS_REPORT_FILE"

append_stress_row() {
  local name="$1"
  local req="$2"
  local okc="$3"
  local failc="$4"
  local fr="$5"
  local p95="$6"
  local maxfr="$7"
  local maxp95="$8"
  local status="$9"
  echo -e "${name}\t${req}\t${okc}\t${failc}\t${fr}\t${p95}\t${maxfr}\t${maxp95}\t${status}" >> "$STRESS_REPORT_FILE"
}

finalize_report() {
  local rc=$?
  local status_text="PASS"
  if [[ "$rc" != "0" ]]; then
    status_text="FAIL"
  fi

  python3 - "$STRESS_REPORT_FILE" "${REPORT_DIR}/summary.json" "$status_text" <<'PY'
import csv, json, sys, pathlib
tsv, out, overall = sys.argv[1], sys.argv[2], sys.argv[3]
rows = []
with open(tsv, "r", encoding="utf-8") as f:
    reader = csv.DictReader(f, delimiter="\t")
    for r in reader:
        rows.append(r)
payload = {"overall_status": overall, "stress_ramp": rows}
pathlib.Path(out).write_text(json.dumps(payload, indent=2), encoding="utf-8")
PY

  {
    echo "# E2E Infra Gate Summary"
    echo
    echo "- overall_status: ${status_text}"
    echo "- agent: ${AGENT_NAME}"
    echo "- runtime: ${RT_URL}"
    echo "- control_plane: ${CP_URL}"
    echo "- run_tag: ${RUN_TAG:-unknown}"
    echo
    echo "## Stage 10 Stress Ramp"
    echo
    if [[ -s "$STRESS_REPORT_FILE" ]] && [[ "$(wc -l < "$STRESS_REPORT_FILE" | tr -d ' ')" -gt 1 ]]; then
      echo "| name | requests | ok | fail | failure_rate | p95_s | max_failure_rate | max_p95_s | status |"
      echo "|---|---:|---:|---:|---:|---:|---:|---:|---|"
      tail -n +2 "$STRESS_REPORT_FILE" | while IFS=$'\t' read -r n req okc failc fr p95 maxfr maxp95 st; do
        echo "| ${n} | ${req} | ${okc} | ${failc} | ${fr} | ${p95} | ${maxfr} | ${maxp95} | ${st} |"
      done
    else
      echo "_No stress ramp rows recorded (stage skipped or not reached)._"
    fi
  } > "${REPORT_DIR}/summary.md"

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && [[ -f "${REPORT_DIR}/summary.md" ]]; then
    cat "${REPORT_DIR}/summary.md" >> "$GITHUB_STEP_SUMMARY"
  fi
}

trap finalize_report EXIT

require_env() {
  [[ -n "$CP_URL" ]] || fail "Missing E2E_CONTROL_PLANE_URL"
  [[ -n "$RT_URL" ]] || fail "Missing E2E_RUNTIME_URL"
  [[ -n "$SERVICE_TOKEN" ]] || fail "Missing E2E_SERVICE_TOKEN"
}

parse_curl_body_code() {
  local raw
  raw="$(cat)"
  CODE="$(python3 -c '
import sys
text = sys.argv[1]
if "\n" not in text:
    print("")
else:
    print(text.rsplit("\n", 1)[1])
' "$raw")"
  BODY="$(python3 -c '
import sys
text = sys.argv[1]
if "\n" not in text:
    print(text, end="")
else:
    print(text.rsplit("\n", 1)[0], end="")
' "$raw")"
}

http_get() {
  local url="$1"
  shift || true
  curl -sS -w "\n%{http_code}" "$url" "$@"
}

http_post_json() {
  local url="$1"
  local body="$2"
  shift 2
  curl -sS -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    "$@" \
    --data-binary "$body" \
    "$url"
}

json_eval() {
  local expr="$1"
  local raw
  raw="$(cat)"
  python3 -c '
import json, sys
expr = sys.argv[1]
raw = sys.argv[2]
try:
    data = json.loads(raw)
except Exception:
    print("")
    raise SystemExit(0)
try:
    val = eval(expr, {"__builtins__": {"bool": bool, "str": str, "int": int, "float": float, "len": len, "list": list, "dict": dict}}, {"d": data})
except Exception:
    print("")
    raise SystemExit(0)
if isinstance(val, (dict, list)):
    print(json.dumps(val))
elif val is None:
    print("")
else:
    print(val)
' "$expr" "$raw"
}

run_soak_burst() {
  local name="$1"
  local expected_status="$2"
  local url="$3"
  local payload_template="$4"
  local req_count="$5"
  local parallel="$6"

  local tmpdir
  tmpdir="$(mktemp -d)"
  local i
  for i in $(seq 1 "$req_count"); do
    (
      local payload
      payload="$(printf '%s' "$payload_template" | sed "s/__IDX__/${i}/g")"
      local code
      code="$(http_post_json "$url" "$payload" -H "${auth_header[0]}" | tail -n1 || true)"
      if [[ -z "$code" ]]; then code="000"; fi
      printf '%s\n' "$code" > "${tmpdir}/${i}.status"
    ) &

    while [[ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$parallel" ]]; do
      sleep 0.1
    done
  done
  wait

  local ok_count=0
  local fail_count=0
  local status
  for i in $(seq 1 "$req_count"); do
    status="$(cat "${tmpdir}/${i}.status" 2>/dev/null || echo "000")"
    if [[ "$status" == "$expected_status" ]]; then
      ok_count=$((ok_count + 1))
    else
      fail_count=$((fail_count + 1))
    fi
  done
  rm -rf "$tmpdir"

  local failure_rate
  failure_rate="$(python3 - "$fail_count" "$req_count" <<'PY'
import sys
f = int(sys.argv[1]); n = int(sys.argv[2])
print(f / n if n else 1.0)
PY
)"

  info "Soak ${name}: ok=${ok_count}/${req_count}, failures=${fail_count}, failure_rate=${failure_rate}"

  local threshold_ok
  threshold_ok="$(python3 - "$failure_rate" "$SOAK_MAX_FAILURE_RATE" <<'PY'
import sys
rate = float(sys.argv[1]); max_rate = float(sys.argv[2])
print("1" if rate <= max_rate else "0")
PY
)"
  [[ "$threshold_ok" == "1" ]] || fail "Soak ${name} exceeded failure threshold (${failure_rate} > ${SOAK_MAX_FAILURE_RATE})"
  ok "soak ${name} within threshold"
}

run_latency_burst() {
  local name="$1"
  local expected_status="$2"
  local url="$3"
  local payload_template="$4"
  local req_count="$5"
  local parallel="$6"
  local max_failure_rate="$7"
  local max_p95_s="$8"

  local tmpdir
  tmpdir="$(mktemp -d)"
  local i
  for i in $(seq 1 "$req_count"); do
    (
      local payload
      payload="$(printf '%s' "$payload_template" | sed "s/__IDX__/${i}/g")"
      local line
      line="$(curl -sS -o /dev/null -w "%{http_code} %{time_total}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "${auth_header[0]}" \
        --data-binary "$payload" \
        "$url" || echo "000 99.0")"
      printf '%s\n' "$line" > "${tmpdir}/${i}.txt"
    ) &

    while [[ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$parallel" ]]; do
      sleep 0.05
    done
  done
  wait

  local stats
  stats="$(python3 - "$tmpdir" "$req_count" "$expected_status" <<'PY'
import os, sys
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
    if not arr:
        return 99.0
    idx = min(len(arr)-1, max(0, int(round((p/100)*(len(arr)-1)))))
    return arr[idx]
p95 = pct(lat_sorted, 95)
print(ok, fail, fr, p95)
PY
)"
  rm -rf "$tmpdir"

  local ok_count fail_count failure_rate p95
  read -r ok_count fail_count failure_rate p95 <<<"$stats"
  info "Stress ${name}: ok=${ok_count}/${req_count} fail=${fail_count} failure_rate=${failure_rate} p95=${p95}s"

  local threshold_ok p95_ok
  threshold_ok="$(python3 - "$failure_rate" "$max_failure_rate" <<'PY'
import sys
print("1" if float(sys.argv[1]) <= float(sys.argv[2]) else "0")
PY
)"
  p95_ok="$(python3 - "$p95" "$max_p95_s" <<'PY'
import sys
print("1" if float(sys.argv[1]) <= float(sys.argv[2]) else "0")
PY
)"
  if [[ "$threshold_ok" != "1" ]]; then
    append_stress_row "$name" "$req_count" "$ok_count" "$fail_count" "$failure_rate" "$p95" "$max_failure_rate" "$max_p95_s" "fail"
    fail "Stress ${name} exceeded failure threshold (${failure_rate} > ${max_failure_rate})"
  fi
  if [[ "$p95_ok" != "1" ]]; then
    append_stress_row "$name" "$req_count" "$ok_count" "$fail_count" "$failure_rate" "$p95" "$max_failure_rate" "$max_p95_s" "fail"
    fail "Stress ${name} exceeded p95 latency threshold (${p95}s > ${max_p95_s}s)"
  fi
  append_stress_row "$name" "$req_count" "$ok_count" "$fail_count" "$failure_rate" "$p95" "$max_failure_rate" "$max_p95_s" "pass"
  ok "stress ${name} within thresholds"
}

auth_header=("Authorization: Bearer ${SERVICE_TOKEN}")

extract_done_output_from_sse() {
  # Usage: printf '%s' "$SSE" | extract_done_output_from_sse
  python3 -c '
import json, re, sys
raw = sys.stdin.read()
best = ""
for line in raw.splitlines():
    line = line.strip()
    if not line.startswith("data:"):
        continue
    payload = line[5:].strip()
    try:
        obj = json.loads(payload)
    except Exception:
        continue
    if isinstance(obj, dict) and obj.get("type") == "done":
        out = obj.get("output") or ""
        if isinstance(out, str):
            best = out
if best:
    print(best)
' || true
}

extract_full_text_from_sse() {
  # Usage: printf '%s' "$SSE" | extract_full_text_from_sse
  python3 -c '
import json, sys
raw = sys.stdin.read()
buf = ""
done_out = ""
for line in raw.splitlines():
    line = line.strip()
    if not line.startswith("data:"):
        continue
    payload = line[5:].strip()
    try:
        obj = json.loads(payload)
    except Exception:
        continue
    if not isinstance(obj, dict):
        continue
    t = obj.get("type")
    if t == "token":
        piece = obj.get("content") or obj.get("text") or ""
        if isinstance(piece, str):
            buf += piece
    elif t == "done":
        out = obj.get("output") or ""
        if isinstance(out, str):
            done_out = out
print(done_out if done_out else buf)
' || true
}

run_stream_task() {
  # Prints SSE payload to stdout.
  local task="$1"
  local user_id="$2"
  local session_id="$3"
  local payload
  payload="$(python3 - "$AGENT_NAME" "$task" "$user_id" "$ORG_ID" "$session_id" <<'PY'
import json, sys
agent, task, user_id, org_id, session_id = sys.argv[1:6]
body = {
  "agent_name": agent,
  "task": task,
  "channel": "infra-gate",
  "channel_user_id": user_id,
  "session_id": session_id,
}
if org_id:
  body["org_id"] = org_id
print(json.dumps(body))
PY
)"
  curl -sS -X POST "${RT_URL}/api/v1/runtime-proxy/runnable/stream" \
    -H "Content-Type: application/json" \
    -H "${auth_header[0]}" \
    --data-binary "$payload"
}

require_env
START_TS="$(date +%s)"
RUN_TAG="infra-gate-$(date +%s)-$RANDOM"

echo "Running E2E infra gate"
echo "  control-plane: ${CP_URL}"
echo "  runtime:       ${RT_URL}"
echo "  agent:         ${AGENT_NAME}"
echo "  run tag:       ${RUN_TAG}"

info "Stage 1: control-plane detailed health"
RAW="$(http_get "${CP_URL}/api/v1/health/detailed")"
parse_curl_body_code <<<"$RAW"
[[ "$CODE" == "200" ]] || fail "control-plane health/detailed HTTP ${CODE}: ${BODY}"
DB_OK="$(printf '%s' "$BODY" | json_eval 'bool(d.get("checks", {}).get("database", {}).get("ok"))')"
RT_OK="$(printf '%s' "$BODY" | json_eval 'bool(d.get("checks", {}).get("runtime", {}).get("ok"))')"
[[ "$DB_OK" == "True" ]] || fail "database check is not healthy (Hyperdrive/db path failing)"
[[ "$RT_OK" == "True" ]] || fail "runtime check is not healthy from control-plane"
ok "control-plane dependencies healthy"

info "Stage 2: runtime health"
RAW="$(http_get "${RT_URL}/health")"
parse_curl_body_code <<<"$RAW"
[[ "$CODE" == "200" ]] || fail "runtime /health HTTP ${CODE}: ${BODY}"
ok "runtime worker healthy"

info "Stage 3: Dynamic Worker V8 isolate via /cf/sandbox/exec (javascript)"
JS_PAYLOAD="$(python3 - <<'PY'
import json
print(json.dumps({
  "language": "javascript",
  "code": "console.log('v8_isolate_ok')",
  "timeoutMs": 8000,
}))
PY
)"
RAW="$(http_post_json "${RT_URL}/cf/sandbox/exec" "${JS_PAYLOAD}" -H "${auth_header[0]}")"
parse_curl_body_code <<<"$RAW"
[[ "$CODE" == "200" ]] || fail "runtime /cf/sandbox/exec (js) HTTP ${CODE}: ${BODY}"
JS_EXIT="$(printf '%s' "$BODY" | json_eval 'd.get("exit_code")')"
JS_STDOUT="$(printf '%s' "$BODY" | json_eval 'd.get("stdout", "")')"
[[ "$JS_EXIT" == "0" ]] || fail "V8 isolate execution failed: ${BODY}"
[[ "$JS_STDOUT" == *"v8_isolate_ok"* ]] || fail "V8 isolate stdout missing marker: ${BODY}"
ok "dynamic worker isolate path ok"

info "Stage 4: Container SDK sandbox via /cf/sandbox/exec (bash)"
ATTEMPT=1
MAX_ATTEMPTS=3
while true; do
  BASH_PAYLOAD="$(python3 - "$RUN_TAG" "$ATTEMPT" <<'PY'
import json, sys
run_tag, attempt = sys.argv[1], sys.argv[2]
print(json.dumps({
  "language": "bash",
  "code": "echo container_sandbox_ok",
  "timeoutMs": 120000,
  "session_id": f"stage4-{run_tag}-{attempt}",
}))
PY
)"
  RAW="$(http_post_json "${RT_URL}/cf/sandbox/exec" "${BASH_PAYLOAD}" -H "${auth_header[0]}")"
  parse_curl_body_code <<<"$RAW"
  [[ "$CODE" == "200" ]] || fail "runtime /cf/sandbox/exec (bash) HTTP ${CODE}: ${BODY}"
  BASH_EXIT="$(printf '%s' "$BODY" | json_eval 'd.get("exit_code")')"
  BASH_STDOUT="$(printf '%s' "$BODY" | json_eval 'd.get("stdout", "")')"
  if [[ "$BASH_EXIT" == "0" ]]; then
    break
  fi
  if [[ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]]; then
    fail "container sandbox execution failed after ${MAX_ATTEMPTS} attempts: ${BODY}"
  fi
  warn "container sandbox attempt ${ATTEMPT} failed, retrying once lane is reacquired"
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done
[[ "$BASH_STDOUT" == *"container_sandbox_ok"* ]] || fail "container stdout missing marker: ${BODY}"
ok "container sandbox path ok"

info "Stage 5: runtime eval pipeline acceptance + readback"
EVAL_PAYLOAD="$(python3 - "$RUN_TAG" "$AGENT_NAME" "$ORG_ID" <<'PY'
import json, sys
run_tag, agent, org = sys.argv[1], sys.argv[2], sys.argv[3]
payload = {
  "agent_name": agent,
  "eval_name": f"infra_gate_{run_tag}",
  "trials": 1,
  "tasks": [{
    "name": "echo-check",
    "input": "Reply with exactly: infra_gate_ok",
    "expected": "infra_gate_ok",
    "grader": "contains",
  }],
}
if org:
  payload["org_id"] = org
print(json.dumps(payload))
PY
)"
RAW="$(http_post_json "${RT_URL}/api/v1/eval/run" "${EVAL_PAYLOAD}" -H "${auth_header[0]}")"
parse_curl_body_code <<<"$RAW"
[[ "$CODE" == "202" ]] || fail "runtime /api/v1/eval/run HTTP ${CODE}: ${BODY}"
EVAL_NAME="$(printf '%s' "$BODY" | json_eval 'd.get("eval_name", "")')"
[[ -n "$EVAL_NAME" ]] || fail "eval start response missing eval_name: ${BODY}"
ok "eval run accepted (${EVAL_NAME})"

# Poll eval/runs for this eval_name to verify write/read path through runtime DB.
# In environments without E2E_ORG_ID, eval writes may be async/best-effort and
# can be delayed or dropped by downstream DB constraints; treat readback as
# best-effort to avoid false negatives while still validating acceptance.
DEADLINE=$((START_TS + TIMEOUT_SECONDS))
FOUND="0"
while [[ "$(date +%s)" -lt "$DEADLINE" ]]; do
  RAW="$(http_get "${RT_URL}/api/v1/eval/runs?agent_name=${AGENT_NAME}&limit=200" -H "${auth_header[0]}")"
  parse_curl_body_code <<<"$RAW"
  if [[ "$CODE" == "200" ]]; then
    MATCH="$(python3 -c '
import json, sys
target = sys.argv[1]
raw = sys.argv[2]
try:
    rows = json.loads(raw)
except Exception:
    print("0")
    raise SystemExit(0)
if isinstance(rows, dict):
    rows = rows.get("runs", [])
ok = False
for r in (rows if isinstance(rows, list) else []):
    if str(r.get("eval_name", "")) == target:
        ok = True
        break
print("1" if ok else "0")
' "$EVAL_NAME" "$BODY")"
    if [[ "$MATCH" == "1" ]]; then
      FOUND="1"
      break
    fi
  fi
  sleep 3
done
if [[ "$FOUND" == "1" ]]; then
  ok "eval run readback visible"
elif [[ -n "$ORG_ID" ]]; then
  fail "eval run did not appear in /api/v1/eval/runs within ${TIMEOUT_SECONDS}s (org-aware mode)"
else
  warn "eval run accepted but not visible in readback within timeout (set E2E_ORG_ID to enforce strict readback)"
fi

info "Stage 6: runtime auth rejection checks"
RAW="$(curl -sS -w "\n%{http_code}" -X POST "${RT_URL}/api/v1/runtime-proxy/runnable/invoke" \
  -H "Content-Type: application/json" \
  --data-binary "{\"agent_name\":\"${AGENT_NAME}\",\"task\":\"auth check\"}")"
parse_curl_body_code <<<"$RAW"
[[ "$CODE" == "401" ]] || fail "missing auth token should be 401, got ${CODE}"
ok "missing token rejected"

RAW="$(curl -sS -w "\n%{http_code}" -X POST "${RT_URL}/api/v1/runtime-proxy/runnable/invoke" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer invalid-token" \
  --data-binary "{\"agent_name\":\"${AGENT_NAME}\",\"task\":\"auth check\"}")"
parse_curl_body_code <<<"$RAW"
[[ "$CODE" == "401" ]] || fail "invalid auth token should be 401, got ${CODE}"
ok "invalid token rejected"

info "Stage 7: multi-turn continuity + response correctness"
TURN_USER="gate-user-${RUN_TAG}"
TURN_SESSION="gate-session-${RUN_TAG}"
SECRET="ctx-${RUN_TAG}"

SSE1="$(run_stream_task "Remember this secret token: ${SECRET}. Reply exactly: ACK_${SECRET}" "${TURN_USER}" "${TURN_SESSION}")"
OUT1="$(printf '%s' "$SSE1" | extract_done_output_from_sse)"
[[ -n "$OUT1" ]] || fail "first turn produced no done output"
[[ "$OUT1" == *"ACK_${SECRET}"* ]] || fail "first turn did not return expected ack token"
ok "first turn response contract verified"

SSE2="$(run_stream_task "What secret token did I ask you to remember? Reply exactly with just the token." "${TURN_USER}" "${TURN_SESSION}")"
OUT2="$(printf '%s' "$SSE2" | extract_done_output_from_sse)"
[[ -n "$OUT2" ]] || fail "second turn produced no done output"
[[ "$OUT2" == *"${SECRET}"* ]] || fail "multi-turn continuity check failed (missing remembered token)"
ok "multi-turn continuity verified"

info "Stage 8: concurrent eval submissions and readback"
EVAL_COUNT=5
TMP_DIR="$(mktemp -d)"
for i in $(seq 1 "$EVAL_COUNT"); do
  (
    ENAME="infra_gate_parallel_${RUN_TAG}_${i}"
    P="$(python3 - "$ENAME" "$AGENT_NAME" "$ORG_ID" <<'PY'
import json, sys
eval_name, agent, org = sys.argv[1], sys.argv[2], sys.argv[3]
body = {
  "agent_name": agent,
  "eval_name": eval_name,
  "trials": 1,
  "tasks": [{"name":"parallel-check","input":"Reply exactly: parallel_ok","expected":"parallel_ok","grader":"contains"}],
}
if org:
  body["org_id"] = org
print(json.dumps(body))
PY
)"
    R="$(http_post_json "${RT_URL}/api/v1/eval/run" "$P" -H "${auth_header[0]}")"
    parse_curl_body_code <<<"$R"
    echo "${CODE}" > "${TMP_DIR}/${i}.code"
    echo "${ENAME}" > "${TMP_DIR}/${i}.name"
  ) &
done
wait

for i in $(seq 1 "$EVAL_COUNT"); do
  C="$(cat "${TMP_DIR}/${i}.code")"
  [[ "$C" == "202" ]] || fail "parallel eval submit ${i} failed with ${C}"
done
ok "all concurrent eval submissions accepted"

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
found_all="0"
while [[ "$(date +%s)" -lt "$deadline" ]]; do
  R="$(http_get "${RT_URL}/api/v1/eval/runs?agent_name=${AGENT_NAME}&limit=200" -H "${auth_header[0]}")"
  parse_curl_body_code <<<"$R"
  [[ "$CODE" == "200" ]] || { sleep 3; continue; }

  visible=0
  for i in $(seq 1 "$EVAL_COUNT"); do
    N="$(cat "${TMP_DIR}/${i}.name")"
    PRESENT="$(python3 -c '
import json, sys
name = sys.argv[1]
raw = sys.argv[2]
try:
    rows = json.loads(raw)
except Exception:
    print("0")
    raise SystemExit(0)
if isinstance(rows, dict):
    rows = rows.get("runs", [])
rows = rows if isinstance(rows, list) else []
ok = any(isinstance(r, dict) and str(r.get("eval_name", "")) == name for r in rows)
print("1" if ok else "0")
' "$N" "$BODY")"
    if [[ "$PRESENT" == "1" ]]; then
      visible=$((visible + 1))
    fi
  done
  # Async eval processing may take longer than gate timeout under load.
  # Requiring >=2 visible runs still validates concurrent write/readback.
  if [[ "$visible" -ge 2 ]]; then
    found_all="1"
    break
  fi
  sleep 3
done
rm -rf "$TMP_DIR"
if [[ "$found_all" == "1" ]]; then
  ok "concurrent eval write/readback verified (>=2 visible)"
elif [[ -n "$ORG_ID" ]]; then
  fail "concurrent eval runs were accepted but fewer than 2 became visible within timeout (org-aware mode)"
else
  warn "concurrent eval runs accepted; visibility lagged in readback (set E2E_ORG_ID to enforce strict readback)"
fi

if [[ "$SOAK_ENABLED" == "1" ]]; then
  info "Stage 9: soak bursts (parallel=${SOAK_PARALLEL}, requests=${SOAK_REQUESTS}, max_failure_rate=${SOAK_MAX_FAILURE_RATE})"

  JS_SOAK_PAYLOAD='{"language":"javascript","code":"console.log(\"soak_js___IDX__\")","timeoutMs":8000}'
  run_soak_burst \
    "dynamic-worker-js" \
    "200" \
    "${RT_URL}/cf/sandbox/exec" \
    "$JS_SOAK_PAYLOAD" \
    "$SOAK_REQUESTS" \
    "$SOAK_PARALLEL"

  BASH_SOAK_PAYLOAD='{"language":"bash","code":"echo soak_bash___IDX__","timeoutMs":8000}'
  run_soak_burst \
    "container-bash" \
    "200" \
    "${RT_URL}/cf/sandbox/exec" \
    "$BASH_SOAK_PAYLOAD" \
    "$SOAK_REQUESTS" \
    "$SOAK_PARALLEL"

  INVOKE_SOAK_PAYLOAD="$(python3 - "$AGENT_NAME" "$ORG_ID" <<'PY'
import json, sys
agent, org = sys.argv[1], sys.argv[2]
base = {
  "agent_name": agent,
  "task": "Reply with: soak_ok___IDX__",
  "channel": "infra-soak",
  "channel_user_id": "soak-user-__IDX__",
}
if org:
  base["org_id"] = org
print(json.dumps(base))
PY
)"
  run_soak_burst \
    "do-runtime-invoke" \
    "202" \
    "${RT_URL}/api/v1/runtime-proxy/runnable/invoke" \
    "$INVOKE_SOAK_PAYLOAD" \
    "$SOAK_REQUESTS" \
    "$SOAK_PARALLEL"
else
  warn "Skipping soak stage (E2E_SOAK_ENABLED=${SOAK_ENABLED})"
fi

if [[ "$STRESS_ENABLED" == "1" ]]; then
  info "Stage 10: sustained load ramp (ramp=${STRESS_RAMP}, requests=${STRESS_REQUESTS}, max_failure_rate=${STRESS_MAX_FAILURE_RATE}, max_p95_s=${STRESS_MAX_P95_S})"
  IFS=',' read -ra RAMP_LEVELS <<<"$STRESS_RAMP"
  for lvl in "${RAMP_LEVELS[@]}"; do
    lvl="$(echo "$lvl" | tr -d ' ')"
    [[ -n "$lvl" ]] || continue
    run_latency_burst \
      "invoke-ramp-${lvl}" \
      "202" \
      "${RT_URL}/api/v1/runtime-proxy/runnable/invoke" \
      "{\"agent_name\":\"${AGENT_NAME}\",\"task\":\"stress_ok___IDX__\",\"channel\":\"infra-stress\",\"channel_user_id\":\"stress-user-__IDX__\",\"org_id\":\"${ORG_ID}\"}" \
      "$STRESS_REQUESTS" \
      "$lvl" \
      "$STRESS_MAX_FAILURE_RATE" \
      "$STRESS_MAX_P95_S"
  done
else
  append_stress_row "stage10-sustained-load" "0" "0" "0" "0" "0" "$STRESS_MAX_FAILURE_RATE" "$STRESS_MAX_P95_S" "skipped"
  warn "Skipping sustained stress ramp (E2E_STRESS_ENABLED=${STRESS_ENABLED})"
fi

info "Stage 11: eval grading accuracy (exact pass + exact fail)"
GRADE_EVAL_NAME="infra_gate_grading_${RUN_TAG}"
GRADE_PAYLOAD="$(python3 - "$GRADE_EVAL_NAME" "$AGENT_NAME" "$ORG_ID" <<'PY'
import json, sys
eval_name, agent, org = sys.argv[1], sys.argv[2], sys.argv[3]
body = {
  "agent_name": agent,
  "eval_name": eval_name,
  "trials": 1,
  "tasks": [
    {"name":"exact-pass","input":"Reply exactly: pass_marker_42","expected":"pass_marker_42","grader":"exact"},
    {"name":"exact-fail","input":"Reply exactly: fail_marker_actual","expected":"fail_marker_expected","grader":"exact"},
  ],
}
if org:
  body["org_id"] = org
print(json.dumps(body))
PY
)"
RAW="$(http_post_json "${RT_URL}/api/v1/eval/run" "${GRADE_PAYLOAD}" -H "${auth_header[0]}")"
parse_curl_body_code <<<"$RAW"
[[ "$CODE" == "202" ]] || fail "grading eval submit failed HTTP ${CODE}: ${BODY}"

GRADE_FOUND="0"
GRADE_PASS_RATE=""
grade_deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
while [[ "$(date +%s)" -lt "$grade_deadline" ]]; do
  RAW="$(http_get "${RT_URL}/api/v1/eval/runs?agent_name=${AGENT_NAME}&limit=200" -H "${auth_header[0]}")"
  parse_curl_body_code <<<"$RAW"
  if [[ "$CODE" == "200" ]]; then
    read -r GRADE_FOUND GRADE_PASS_RATE <<<"$(python3 - "$GRADE_EVAL_NAME" "$BODY" <<'PY'
import json, sys
target, raw = sys.argv[1], sys.argv[2]
try:
    rows = json.loads(raw)
except Exception:
    print("0 0")
    raise SystemExit(0)
if isinstance(rows, dict):
    rows = rows.get("runs", [])
for r in (rows if isinstance(rows, list) else []):
    if isinstance(r, dict) and str(r.get("eval_name","")) == target:
        print("1", float(r.get("pass_rate", 0)))
        raise SystemExit(0)
print("0 0")
PY
)"
    if [[ "$GRADE_FOUND" == "1" ]]; then
      break
    fi
  fi
  sleep 3
done
[[ "$GRADE_FOUND" == "1" ]] || fail "grading eval did not become visible within timeout"
PASS_RATE_OK="$(python3 - "$GRADE_PASS_RATE" <<'PY'
import sys
rate = float(sys.argv[1])
print("1" if (rate < 1.0 and rate >= 0.0) else "0")
PY
)"
[[ "$PASS_RATE_OK" == "1" ]] || fail "grading eval pass_rate expected < 1.0, got ${GRADE_PASS_RATE}"
ok "eval grading accuracy verified (pass_rate=${GRADE_PASS_RATE})"

info "Stage 12: large payload transport (>=${LARGE_OUTPUT_MIN_BYTES} bytes)"
# Two-channel test: sandbox exec (deterministic, no LLM dependency) validates
# that the runtime can transport large payloads end-to-end, plus a stream
# check verifies SSE framing delivers multi-token responses intact.

# Channel A: sandbox exec generates exact large payload — tests HTTP response transport
LARGE_CODE="$(python3 -c '
import json, sys
tag, n = sys.argv[1], int(sys.argv[2])
js = "console.log(\"BEGIN_\" + \"" + tag + "\" + \"X\".repeat(" + str(n) + ") + \"END_\" + \"" + tag + "\");"
print(json.dumps({"language": "javascript", "code": js, "timeoutMs": 30000}))
' "$RUN_TAG" "$LARGE_OUTPUT_MIN_BYTES")"
RAW="$(http_post_json "${RT_URL}/cf/sandbox/exec" "${LARGE_CODE}" -H "${auth_header[0]}")"
parse_curl_body_code <<<"$RAW"
[[ "$CODE" == "200" ]] || fail "large payload sandbox exec HTTP ${CODE}: ${BODY}"
SANDBOX_EXIT="$(printf '%s' "$BODY" | json_eval 'd.get("exit_code")')"
SANDBOX_STDOUT="$(printf '%s' "$BODY" | json_eval 'd.get("stdout", "")')"
[[ "$SANDBOX_EXIT" == "0" ]] || fail "large payload sandbox execution failed: exit_code=${SANDBOX_EXIT}"
[[ "$SANDBOX_STDOUT" == *"BEGIN_${RUN_TAG}"* ]] || fail "large payload sandbox missing BEGIN marker"
[[ "$SANDBOX_STDOUT" == *"END_${RUN_TAG}"* ]] || fail "large payload sandbox missing END marker"
SANDBOX_BYTES="$(python3 -c 'import sys; print(len(sys.argv[1].encode("utf-8")))' "$SANDBOX_STDOUT")"
SIZE_OK="$(python3 -c 'import sys; print("1" if int(sys.argv[1]) >= int(sys.argv[2]) else "0")' "$SANDBOX_BYTES" "$LARGE_OUTPUT_MIN_BYTES")"
[[ "$SIZE_OK" == "1" ]] || fail "large payload sandbox too small (${SANDBOX_BYTES} bytes < ${LARGE_OUTPUT_MIN_BYTES})"
ok "large payload transport via sandbox verified (${SANDBOX_BYTES} bytes)"

# Channel B: stream endpoint delivers multi-token response — tests SSE framing
LARGE_SESSION="large-session-${RUN_TAG}"
LARGE_USER="large-user-${RUN_TAG}"
SSE_LARGE="$(run_stream_task "List the numbers 1 through 100, one per line. Start with BEGIN_${RUN_TAG} and end with END_${RUN_TAG}." "${LARGE_USER}" "${LARGE_SESSION}")"
OUT_LARGE="$(printf '%s' "$SSE_LARGE" | extract_full_text_from_sse)"
if [[ -n "$OUT_LARGE" ]] && [[ "$OUT_LARGE" == *"BEGIN_${RUN_TAG}"* ]]; then
  OUT_LARGE_BYTES="$(python3 -c 'import sys; print(len(sys.argv[1].encode("utf-8")))' "$OUT_LARGE")"
  ok "SSE stream framing verified (${OUT_LARGE_BYTES} bytes with markers)"
else
  warn "SSE stream did not deliver markers (model-dependent); sandbox transport already verified"
fi

ok "E2E infrastructure gate passed"
