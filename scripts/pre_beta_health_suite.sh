#!/usr/bin/env bash
# Pre-beta health suite
# - Runs infra gate (optional)
# - Verifies runtime completion contract on plan-heavy prompts
# - Confirms session/turn persistence for traced runs

set -euo pipefail

CP_URL="${E2E_CONTROL_PLANE_URL:-https://api.oneshots.co}"
CP_URL="${CP_URL%/}"
ORG_ID="${E2E_ORG_ID:-}"
AGENT_NAME="${E2E_AGENT_NAME:-my-assistant}"
USER_EMAIL="${E2E_USER_EMAIL:-}"
USER_PASSWORD="${E2E_USER_PASSWORD:-}"
TIMEOUT_SECONDS="${E2E_TIMEOUT_SECONDS:-180}"
RUN_INFRA_GATE="${PREBETA_RUN_INFRA_GATE:-1}"
REPORT_DIR="${PREBETA_REPORT_DIR:-artifacts/prebeta-health}"
MAX_TTFT_P95_MS="${PREBETA_MAX_TTFT_P95_MS:-12000}"
MAX_DONE_MISSING_RATE="${PREBETA_MAX_DONE_MISSING_RATE:-0.20}"
MAX_COMPLETION_GATE_EXHAUSTED_RATE="${PREBETA_MAX_COMPLETION_GATE_EXHAUSTED_RATE:-0.05}"
RUN_REAL_TASK_CHAIN="${PREBETA_RUN_REAL_TASK_CHAIN:-1}"

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
SUMMARY_JSON_PATH="${REPORT_DIR}/summary.json"
SUMMARY_MD_PATH="${REPORT_DIR}/summary.md"

require_env() {
  [[ -n "$ORG_ID" ]] || fail "Missing E2E_ORG_ID"
  [[ -n "$USER_EMAIL" ]] || fail "Missing E2E_USER_EMAIL"
  [[ -n "$USER_PASSWORD" ]] || fail "Missing E2E_USER_PASSWORD"
}

login_token() {
  curl -sS -X POST "${CP_URL}/api/v1/auth/login" \
    --max-time 20 \
    -H "Content-Type: application/json" \
    --data "{\"email\":\"${USER_EMAIL}\",\"password\":\"${USER_PASSWORD}\"}" | \
    python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))'
}

run_stream() {
  local token="$1"
  local prompt="$2"
  local user_tag="$3"
  curl -sS -N --max-time "${TIMEOUT_SECONDS}" -X POST "${CP_URL}/api/v1/runtime-proxy/runnable/stream" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    --data "{\"agent_name\":\"${AGENT_NAME}\",\"org_id\":\"${ORG_ID}\",\"channel\":\"prebeta\",\"channel_user_id\":\"${user_tag}\",\"input\":\"${prompt}\"}" || true
}

parse_sse_summary() {
  local raw_input="$1"
  python3 - "$raw_input" <<'PY'
import json, re, sys
raw = sys.argv[1]
lines = [ln[6:] for ln in raw.splitlines() if ln.startswith("data: ")]
counts = {}
done = None
warnings = 0
for ln in lines:
    try:
        evt = json.loads(ln)
    except Exception:
        continue
    t = evt.get("type") or evt.get("event_type") or "unknown"
    counts[t] = counts.get(t, 0) + 1
    if t == "warning":
        warnings += 1
    sid = evt.get("session_id")
    if sid and not (done and done.get("session_id")):
        session_hint = sid
    if t == "done":
        done = evt
out = done.get("output","") if isinstance(done, dict) else ""
summary = {
    "frames": len(lines),
    "event_counts": counts,
    "warnings": warnings,
    "done_found": bool(done),
    "session_id": (done or {}).get("session_id","") or locals().get("session_hint",""),
    "termination_reason": (done or {}).get("termination_reason",""),
    "turns": int((done or {}).get("turns", 0) or 0),
    "tool_calls": int((done or {}).get("tool_calls", 0) or 0),
    "completion_gate_interventions": int((done or {}).get("completion_gate_interventions", 0) or 0),
    "completion_gate_reason": (done or {}).get("completion_gate_reason",""),
    "done_latency_ms": int((done or {}).get("latency_ms", 0) or 0),
    "output_len": len(str(out)),
    "has_plan_markers": bool(re.search(r"##\s*Plan|Step\s*1|Executing now", str(out), re.I)),
    "output_head": str(out)[:220].replace("\n", " "),
}
print(json.dumps(summary))
PY
}

http_get_json() {
  local token="$1"
  local path="$2"
  curl -sS --max-time 20 "${CP_URL}${path}" -H "Authorization: Bearer ${token}"
}

workspace_list_json() {
  local token="$1"
  http_get_json "$token" "/api/v1/workspace/files?agent_name=${AGENT_NAME}"
}

assert_workspace_has_files() {
  local list_json="$1"
  shift
  python3 - <<'PY' "$list_json" "$@"
import json, os, sys
rows = json.loads(sys.argv[1]) if sys.argv[1].strip() else []
if isinstance(rows, dict):
    rows = rows.get("files", rows.get("rows", []))
if not isinstance(rows, list):
    raise SystemExit("workspace_list_not_array")
seen = set()
for r in rows:
    if isinstance(r, dict):
        p = str(r.get("path") or r.get("name") or "").strip()
    else:
        p = str(r).strip()
    if p:
        seen.add(os.path.basename(p))
missing = [os.path.basename(x) for x in sys.argv[2:] if os.path.basename(x) not in seen]
if missing:
    raise SystemExit("missing_workspace_files:" + ",".join(missing))
print("ok")
PY
}

json_field() {
  local raw="$1"
  local expr="$2"
  python3 - <<'PY' "$raw" "$expr"
import json, sys
raw, expr = sys.argv[1], sys.argv[2]
try:
    d = json.loads(raw)
except Exception:
    print("")
    raise SystemExit(0)
try:
    print(eval(expr, {"__builtins__": {"len": len, "str": str, "int": int, "bool": bool}}, {"d": d}))
except Exception:
    print("")
PY
}

wait_for_terminal_session() {
  local token="$1"
  local session_id="$2"
  local timeout_s="${3:-180}"
  local start_ts
  start_ts="$(date +%s)"
  while (( "$(date +%s)" - start_ts < timeout_s )); do
    local s_json status
    s_json="$(http_get_json "$token" "/api/v1/sessions/${session_id}")"
    status="$(json_field "$s_json" 'str(d.get("status",""))')"
    if [[ "$status" == "success" || "$status" == "error" || "$status" == "failed" ]]; then
      printf '%s' "$s_json"
      return 0
    fi
    sleep 3
  done
  return 1
}

hydrate_summary_from_persisted_session() {
  local token="$1"
  local summary_json="$2"
  local sid
  sid="$(json_field "$summary_json" 'str(d.get("session_id",""))')"
  [[ -n "$sid" ]] || { printf '%s' "$summary_json"; return 0; }
  local s_json
  s_json="$(wait_for_terminal_session "$token" "$sid" 210 || true)"
  if [[ -z "$s_json" ]]; then
    printf '%s' "$summary_json"
    return 0
  fi
  local t_json
  t_json="$(http_get_json "$token" "/api/v1/sessions/${sid}/turns")"
  python3 - <<'PY' "$summary_json" "$s_json" "$t_json"
import json, re, sys
summary = json.loads(sys.argv[1]) if sys.argv[1].strip() else {}
session = json.loads(sys.argv[2]) if sys.argv[2].strip() else {}
turns = json.loads(sys.argv[3]) if sys.argv[3].strip() else []
if not isinstance(turns, list):
    turns = []
tool_turns = sum(1 for r in turns if isinstance(r, dict) and str(r.get("stop_reason","")) == "tool_calls")
summary["done_found"] = True
summary["termination_reason"] = str(session.get("termination_reason", summary.get("termination_reason","")))
summary["turns"] = max(int(summary.get("turns", 0) or 0), len(turns))
summary["tool_calls"] = max(int(summary.get("tool_calls", 0) or 0), tool_turns)
out = str(session.get("output_text",""))
summary["output_len"] = len(out) if out else int(summary.get("output_len", 0) or 0)
summary["output_head"] = out[:220].replace("\n", " ") if out else str(summary.get("output_head",""))
summary["has_plan_markers"] = bool(re.search(r"##\s*Plan|Step\s*1|Executing now", summary["output_head"], re.I))
print(json.dumps(summary))
PY
}

validate_turns_for_execution() {
  local token="$1"
  local session_id="$2"
  local turns_json
  turns_json="$(http_get_json "$token" "/api/v1/sessions/${session_id}/turns")"
  python3 - <<'PY' "$turns_json"
import json, sys
rows = json.loads(sys.argv[1])
if not isinstance(rows, list):
    print("turns_not_list")
    raise SystemExit(1)
if len(rows) < 2:
    print("too_few_turns")
    raise SystemExit(1)
has_tool_turn = any(str(r.get("stop_reason","")) == "tool_calls" for r in rows if isinstance(r, dict))
if not has_tool_turn:
    print("missing_tool_execution_turn")
    raise SystemExit(1)
print("ok")
PY
}

turn_ttft_series_ms() {
  local token="$1"
  local session_id="$2"
  local turns_json
  turns_json="$(http_get_json "$token" "/api/v1/sessions/${session_id}/turns")"
  python3 - <<'PY' "$turns_json"
import json, sys
rows = json.loads(sys.argv[1]) if sys.argv[1].strip() else []
if not isinstance(rows, list):
    rows = []
vals = []
for r in rows:
    if not isinstance(r, dict):
        continue
    v = r.get("ttft_ms")
    try:
        n = int(v)
        if n > 0:
            vals.append(n)
    except Exception:
        pass
print(" ".join(str(x) for x in vals))
PY
}

p95_from_series() {
  python3 - <<'PY' "$*"
import sys
vals = [int(x) for x in sys.argv[1].split() if x.strip().isdigit()]
if not vals:
    print(0)
    raise SystemExit(0)
vals.sort()
idx = int(round(0.95 * (len(vals) - 1)))
idx = max(0, min(idx, len(vals) - 1))
print(vals[idx])
PY
}

validate_session_terminal_guard() {
  local token="$1"
  local session_id="$2"
  local session_json
  session_json="$(http_get_json "$token" "/api/v1/sessions/${session_id}")"
  python3 - <<'PY' "$session_json"
import json, sys
s = json.loads(sys.argv[1]) if sys.argv[1].strip() else {}
term = str(s.get("termination_reason",""))
out = str(s.get("output_text",""))
if term == "completion_gate_exhausted" or "could not safely finalize" in out.lower():
    print("ok")
else:
    print("missing_completion_gate_terminal_guard")
    raise SystemExit(1)
PY
}

main() {
  require_env
  local probe_attempts_total=0
  local probe_done_missing=0
  local completion_gate_exhausted_count=0
  local completion_gate_eval_count=0
  local ttft_series=""
  local baseline_session_id=""
  local run_tag
  run_tag="prebeta-$(date +%s)-$RANDOM"
  local chain_summary_json='{}'

  if [[ "$RUN_INFRA_GATE" == "1" ]]; then
    info "Running infra gate first"
    bash scripts/e2e_infra_gate.sh
  else
    warn "Skipping infra gate (PREBETA_RUN_INFRA_GATE=${RUN_INFRA_GATE})"
  fi

  info "Logging in with beta test user"
  TOKEN="$(login_token)"
  [[ -n "$TOKEN" ]] || fail "Login failed or empty token"
  ok "Authenticated"

  info "Probe 1: baseline done contract"
  SUM1=""
  for attempt in 1 2; do
    probe_attempts_total=$((probe_attempts_total + 1))
    SSE1="$(run_stream "$TOKEN" "Reply with exactly: ok" "prebeta-quick-$(date +%s)-${attempt}")"
    SUM1="$(parse_sse_summary "$SSE1")"
    SUM1="$(hydrate_summary_from_persisted_session "$TOKEN" "$SUM1")"
    DONE1="$(python3 - <<'PY' "$SUM1"
import json, sys
s = json.loads(sys.argv[1])
print("1" if s.get("done_found") else "0")
PY
)"
    if [[ "$DONE1" == "1" ]]; then
      break
    fi
    probe_done_missing=$((probe_done_missing + 1))
    warn "Probe 1 attempt ${attempt} did not include done; retrying"
  done
  python3 - <<'PY' "$SUM1"
import json, sys
s = json.loads(sys.argv[1])
assert s["done_found"], "missing_done_event"
assert s["termination_reason"], "missing_termination_reason"
assert s["session_id"], "missing_session_id"
print("ok")
PY
  ok "Baseline done contract verified"
  baseline_session_id="$(json_field "$SUM1" 'str(d.get("session_id",""))')"
  baseline_done_latency_ms="$(json_field "$SUM1" 'int(d.get("done_latency_ms", 0) or 0)')"
  if [[ -n "$baseline_session_id" ]]; then
    ttft_series="${ttft_series} $(turn_ttft_series_ms "$TOKEN" "$baseline_session_id")"
  fi
  if [[ "${baseline_done_latency_ms}" -gt 0 ]]; then
    ttft_series="${ttft_series} ${baseline_done_latency_ms}"
  fi

  info "Probe 2: plan-trap completion gate"
  PLAN_PROMPT="For a competitive analysis of agentic harness platforms, first output a detailed plan with Step 1, Step 2, Step 3 and the phrase Executing now. Then continue and deliver actual findings with source links."
  SUM2=""
  for attempt in 1 2; do
    probe_attempts_total=$((probe_attempts_total + 1))
    SSE2="$(run_stream "$TOKEN" "$PLAN_PROMPT" "prebeta-gate-$(date +%s)-${attempt}")"
    SUM2="$(parse_sse_summary "$SSE2")"
    SUM2="$(hydrate_summary_from_persisted_session "$TOKEN" "$SUM2")"
    DONE2="$(python3 - <<'PY' "$SUM2"
import json, sys
s = json.loads(sys.argv[1])
print("1" if s.get("done_found") else "0")
PY
)"
    if [[ "$DONE2" == "1" ]]; then
      break
    fi
    probe_done_missing=$((probe_done_missing + 1))
    warn "Probe 2 attempt ${attempt} did not include done; retrying"
  done
  SESSION_MODE="$(python3 - <<'PY' "$SUM2"
import json, sys
s = json.loads(sys.argv[1])
assert s["done_found"], "missing_done_event"
assert s["session_id"], "missing_session_id"
executed_after_gate = s["completion_gate_interventions"] >= 1 and s["tool_calls"] >= 1
guarded_terminal = (
    str(s.get("termination_reason","")) == "completion_gate_exhausted"
    or "could not safely finalize" in str(s.get("output_head","")).lower()
)
natural_completion = (
    not bool(s.get("has_plan_markers"))
    and int(s.get("output_len", 0) or 0) >= 200
    and str(s.get("termination_reason","")) in ("stop", "completed", "")
)
assert executed_after_gate or guarded_terminal or natural_completion, "completion_contract_not_satisfied"
mode = "executed" if executed_after_gate else ("guarded_terminal" if guarded_terminal else "natural_completion")
print(f'{s["session_id"]}|{mode}')
PY
)"
  SESSION2="${SESSION_MODE%%|*}"
  MODE2="${SESSION_MODE##*|}"
  ok "Completion contract enforced (session=${SESSION2}, mode=${MODE2})"
  completion_gate_eval_count=$((completion_gate_eval_count + 1))
  if [[ "$MODE2" == "guarded_terminal" ]]; then
    completion_gate_exhausted_count=$((completion_gate_exhausted_count + 1))
  fi
  if [[ -n "$SESSION2" ]]; then
    ttft_series="${ttft_series} $(turn_ttft_series_ms "$TOKEN" "$SESSION2")"
  fi
  session2_done_latency_ms="$(json_field "$SUM2" 'int(d.get("done_latency_ms", 0) or 0)')"
  if [[ "${session2_done_latency_ms}" -gt 0 ]]; then
    ttft_series="${ttft_series} ${session2_done_latency_ms}"
  fi

  if [[ "$MODE2" == "executed" ]]; then
    info "Probe 3: persisted turns show actual execution"
    validate_turns_for_execution "$TOKEN" "$SESSION2" >/dev/null
    ok "Turn persistence confirms post-plan execution"
  elif [[ "$MODE2" == "guarded_terminal" ]]; then
    info "Probe 3: terminal guard persisted on session record"
    validate_session_terminal_guard "$TOKEN" "$SESSION2" >/dev/null
    ok "Terminal completion guard persisted correctly"
  else
    ok "Natural non-plan completion detected (gate did not need intervention)"
  fi

  if [[ "$RUN_REAL_TASK_CHAIN" == "1" ]]; then
    info "Probe 4: real-task orchestration chain (md -> docx -> pdf -> extract -> chart)"
    local chain_md="/workspace/${run_tag}.md"
    local chain_docx="/workspace/${run_tag}.docx"
    local chain_pdf="/workspace/${run_tag}.pdf"
    local chain_png="/workspace/${run_tag}.png"
    local chain_prompt chain_sse chain_sum chain_done chain_sid
    chain_prompt="Run a full office pipeline now: create ${chain_md} with a short AI digest, convert it to ${chain_docx} using pandoc, convert that to ${chain_pdf} using soffice headless, extract the first line from the PDF text, generate a simple line chart at ${chain_png} using python, then end your response with exactly CHAIN_OK:${run_tag} and include EXTRACT_HEAD: with the extracted line."
    chain_sse="$(run_stream "$TOKEN" "$chain_prompt" "prebeta-chain-${run_tag}")"
    chain_sum="$(parse_sse_summary "$chain_sse")"
    chain_sum="$(hydrate_summary_from_persisted_session "$TOKEN" "$chain_sum")"
    chain_done="$(json_field "$chain_sum" 'bool(d.get("done_found", False))')"
    [[ "$chain_done" == "True" ]] || fail "real-task chain missing done event"
    chain_sid="$(json_field "$chain_sum" 'str(d.get("session_id",""))')"
    if [[ -n "$chain_sid" ]]; then
      ttft_series="${ttft_series} $(turn_ttft_series_ms "$TOKEN" "$chain_sid")"
    fi
    local chain_out
    chain_out="$(json_field "$chain_sum" 'str(d.get("output_head",""))')"
    if [[ "$chain_out" != *"CHAIN_OK:${run_tag}"* ]]; then
      warn "Real-task chain output head did not include completion marker; checking persisted session output"
      local s_json out_text
      s_json="$(http_get_json "$TOKEN" "/api/v1/sessions/${chain_sid}")"
      out_text="$(json_field "$s_json" 'str(d.get("output_text",""))')"
      [[ "$out_text" == *"CHAIN_OK:${run_tag}"* ]] || fail "real-task chain missing CHAIN_OK marker"
      [[ "$out_text" == *"EXTRACT_HEAD:"* ]] || fail "real-task chain missing EXTRACT_HEAD marker"
    fi
    local list_json
    list_json="$(workspace_list_json "$TOKEN")"
    assert_workspace_has_files "$list_json" "$chain_md" "$chain_docx" "$chain_pdf" "$chain_png" >/dev/null
    ok "Real-task orchestration verified and workspace artifacts found"
    chain_summary_json="$(python3 - <<'PY' "$chain_sum" "$chain_md" "$chain_docx" "$chain_pdf" "$chain_png"
import json, sys
s = json.loads(sys.argv[1]) if sys.argv[1].strip() else {}
print(json.dumps({
  "session_id": s.get("session_id", ""),
  "termination_reason": s.get("termination_reason", ""),
  "tool_calls": int(s.get("tool_calls", 0) or 0),
  "output_head": str(s.get("output_head", "")),
  "artifacts": sys.argv[2:6],
}))
PY
)"
  else
    warn "Skipping real-task orchestration probe (PREBETA_RUN_REAL_TASK_CHAIN=${RUN_REAL_TASK_CHAIN})"
  fi

  local done_missing_rate ttft_p95_ms completion_gate_exhausted_rate
  done_missing_rate="$(python3 - <<'PY' "$probe_done_missing" "$probe_attempts_total"
import sys
m = int(sys.argv[1]); n = int(sys.argv[2])
print((m / n) if n else 1.0)
PY
)"
  ttft_p95_ms="$(p95_from_series "$ttft_series")"
  completion_gate_exhausted_rate="$(python3 - <<'PY' "$completion_gate_exhausted_count" "$completion_gate_eval_count"
import sys
e = int(sys.argv[1]); n = int(sys.argv[2])
print((e / n) if n else 0.0)
PY
)"

  python3 - <<'PY' \
    "$done_missing_rate" "$MAX_DONE_MISSING_RATE" \
    "$ttft_p95_ms" "$MAX_TTFT_P95_MS" \
    "$completion_gate_exhausted_rate" "$MAX_COMPLETION_GATE_EXHAUSTED_RATE"
import sys
dmr, dmr_max, ttft, ttft_max, cgr, cgr_max = map(float, sys.argv[1:])
if dmr > dmr_max:
    raise SystemExit(f"done_missing_rate {dmr:.4f} exceeds {dmr_max:.4f}")
if ttft > ttft_max:
    raise SystemExit(f"ttft_p95_ms {ttft:.0f} exceeds {ttft_max:.0f}")
if cgr > cgr_max:
    raise SystemExit(f"completion_gate_exhausted_rate {cgr:.4f} exceeds {cgr_max:.4f}")
PY
  ok "SLO thresholds passed"

  python3 - <<'PY' \
    "$SUMMARY_JSON_PATH" "$SUM1" "$SUM2" \
    "$chain_summary_json" \
    "$done_missing_rate" "$ttft_p95_ms" "$completion_gate_exhausted_rate" \
    "$MAX_DONE_MISSING_RATE" "$MAX_TTFT_P95_MS" "$MAX_COMPLETION_GATE_EXHAUSTED_RATE"
import json, pathlib, sys
path, s1, s2, chain, dmr, ttft, cgr, dmr_max, ttft_max, cgr_max = sys.argv[1:]
payload = {
  "overall_status": "pass",
  "probes": {
    "baseline": json.loads(s1),
    "completion_gate": json.loads(s2),
    "real_task_chain": json.loads(chain),
  },
  "slo": {
    "done_missing_rate": {"actual": float(dmr), "max": float(dmr_max)},
    "ttft_p95_ms": {"actual": float(ttft), "max": float(ttft_max)},
    "completion_gate_exhausted_rate": {"actual": float(cgr), "max": float(cgr_max)},
  }
}
pathlib.Path(path).write_text(json.dumps(payload, indent=2), encoding="utf-8")
PY

  {
    echo "# Pre-Beta Health Suite"
    echo
    echo "- overall_status: pass"
    echo "- done_missing_rate: ${done_missing_rate} (max ${MAX_DONE_MISSING_RATE})"
    echo "- ttft_p95_ms: ${ttft_p95_ms} (max ${MAX_TTFT_P95_MS})"
    echo "- completion_gate_exhausted_rate: ${completion_gate_exhausted_rate} (max ${MAX_COMPLETION_GATE_EXHAUSTED_RATE})"
    echo
    echo "## Probe Summaries"
    echo
    echo "- baseline: ${SUM1}"
    echo "- completion_gate: ${SUM2}"
    echo "- real_task_chain: ${chain_summary_json}"
  } > "$SUMMARY_MD_PATH"

  info "Pre-beta health suite complete"
  echo "Summary:"
  echo "  baseline: ${SUM1}"
  echo "  completion_gate: ${SUM2}"
  echo "  report_json: ${SUMMARY_JSON_PATH}"
  echo "  report_md: ${SUMMARY_MD_PATH}"
}

main "$@"

