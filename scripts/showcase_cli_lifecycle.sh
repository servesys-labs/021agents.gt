#!/usr/bin/env bash
set -uo pipefail

# AgentOS CLI full-lifecycle showcase script
# - Meta-agent creation (one-shot builder)
# - Agent execution with tool usage
# - RAG ingest + query
# - Eval + evolve loop
# - Deploy + releases/canary via API
# - Memory + sandbox API calls
# - Codemap SVG generation
#
# Usage:
#   bash scripts/showcase_cli_lifecycle.sh
# Optional env overrides:
#   DEMO_AGENT_NAME=demo-agent DEMO_API_PORT=8340 bash scripts/showcase_cli_lifecycle.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CLI="${ROOT_DIR}/.venv/bin/python -m agentos.cli"
API_PORT="${DEMO_API_PORT:-8340}"
API_BASE="http://127.0.0.1:${API_PORT}"
AGENT_NAME="${DEMO_AGENT_NAME:-demo-lifecycle-agent}"
DEMO_EMAIL="demo.$(date +%s)@oneshots.local"
DEMO_PASSWORD="pass12345"

COLOR_RESET="\033[0m"
COLOR_BOLD="\033[1m"
COLOR_CYAN="\033[36m"
COLOR_GREEN="\033[32m"
COLOR_YELLOW="\033[33m"
COLOR_RED="\033[31m"
COLOR_BLUE="\033[34m"
COLOR_MAGENTA="\033[35m"

STARTED_API=0
API_PID=""
AUTH_TOKEN=""

print_banner() {
  echo -e "${COLOR_BOLD}${COLOR_MAGENTA}"
  echo "======================================================================="
  echo " AgentOS CLI Platform Showcase (End-to-End Lifecycle)"
  echo "======================================================================="
  echo -e "${COLOR_RESET}"
}

step() {
  echo
  echo -e "${COLOR_BOLD}${COLOR_CYAN}▶ $1${COLOR_RESET}"
}

info() {
  echo -e "${COLOR_BLUE}  • $1${COLOR_RESET}"
}

ok() {
  echo -e "${COLOR_GREEN}  ✓ $1${COLOR_RESET}"
}

warn() {
  echo -e "${COLOR_YELLOW}  ⚠ $1${COLOR_RESET}"
}

err() {
  echo -e "${COLOR_RED}  ✗ $1${COLOR_RESET}"
}

run_or_warn() {
  local desc="$1"
  shift
  info "$desc"
  if "$@"; then
    ok "$desc"
    return 0
  fi
  warn "$desc failed (continuing demo)"
  return 1
}

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

json_nested_field() {
  local expr="$1"
  python3 - "$expr" <<'PY'
import json, sys
expr = sys.argv[1]
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception:
    print("")
    raise SystemExit(0)
cur = data
for part in expr.split("."):
    if isinstance(cur, dict):
        cur = cur.get(part, "")
    else:
        cur = ""
        break
if isinstance(cur, (dict, list)):
    print(json.dumps(cur))
else:
    print(cur if cur is not None else "")
PY
}

cleanup() {
  if [[ "$STARTED_API" -eq 1 && -n "$API_PID" ]]; then
    warn "Stopping demo API server (pid ${API_PID})"
    kill "$API_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ ! -x "${ROOT_DIR}/.venv/bin/python" ]]; then
  err "Python virtualenv not found at .venv. Please set up the project first."
  exit 1
fi

print_banner

step "1) Platform surface: commands, agents, tools, plans"
run_or_warn "CLI help" bash -lc "${CLI} --help"
run_or_warn "List agents" bash -lc "${CLI} list"
run_or_warn "List tools" bash -lc "${CLI} tools"
run_or_warn "List model plans" bash -lc "${CLI} plans list"

step "2) Meta-agent creation (one-shot builder) -> create a new demo agent"
CREATE_DESC="Create an advanced research-and-ops agent that can search web, read/edit files, run bash, use HTTP APIs, and provide concise executive summaries."
run_or_warn "Create '${AGENT_NAME}' via one-shot builder" \
  bash -lc "${CLI} create --one-shot \"${CREATE_DESC}\" --name \"${AGENT_NAME}\" --tools \"web-search,knowledge-search,store-knowledge,bash,read-file,write-file,edit-file,grep,glob,http-request,browse,python-exec\" --force"

step "3) Prepare local workspace artifacts for tool interactions"
mkdir -p demo_assets
cat > demo_assets/notes.txt <<'EOF'
AgentOS demo note:
- objective: demonstrate tool usage and lifecycle
- audience: teammate
- status: in-progress
EOF
ok "Created demo_assets/notes.txt"

step "4) Run the agent with a tool-heavy prompt (verbose mode)"
TASK_PROMPT="Use tools to do the following in order: (1) glob demo_assets files, (2) read demo_assets/notes.txt, (3) edit it by adding one line 'status: demo-ready', (4) run a bash command 'ls -la demo_assets', (5) do one web search about 'model context protocol', then summarize what you did."
run_or_warn "Run '${AGENT_NAME}' with verbose output" \
  bash -lc "${CLI} run \"${AGENT_NAME}\" \"${TASK_PROMPT}\" --verbose --stream"

step "5) RAG ingestion + retrieval-oriented run"
run_or_warn "Ingest architecture doc into RAG for ${AGENT_NAME}" \
  bash -lc "${CLI} ingest \"${AGENT_NAME}\" docs/misc/ARCHITECTURE_REVIEW.md --chunk-size 400"
run_or_warn "Run RAG-style question" \
  bash -lc "${CLI} run \"${AGENT_NAME}\" \"Based on ingested docs, list 3 architecture highlights in bullets.\" --quiet"

step "6) Quality loop: eval benchmark"
run_or_warn "Run eval on smoke tasks (1 trial)" \
  bash -lc "${CLI} eval \"${AGENT_NAME}\" eval/smoke-test.json --trials 1"

step "7) Continuous improvement: evolve loop"
run_or_warn "Run evolve auto-approve cycle and export report" \
  bash -lc "${CLI} evolve \"${AGENT_NAME}\" eval/smoke-test.json --trials 1 --max-cycles 1 --auto-approve --export data/demo-evolve.json"

step "8) Deployment artifact generation"
run_or_warn "Generate deploy config scaffold for ${AGENT_NAME}" \
  bash -lc "${CLI} deploy \"${AGENT_NAME}\""
if [[ -f deploy/agent-config.json ]]; then
  ok "Deploy config available at deploy/agent-config.json"
fi

step "9) Ensure API server is running (for memory/sandbox/releases/canary)"
if curl -sS "${API_BASE}/health" >/dev/null 2>&1; then
  ok "API already running at ${API_BASE}"
else
  warn "API not detected; starting local server on ${API_PORT}"
  nohup bash -lc "${CLI} serve --port ${API_PORT} --host 127.0.0.1" >/tmp/agentos-showcase-api.log 2>&1 &
  API_PID="$!"
  STARTED_API=1
  for _ in {1..25}; do
    if curl -sS "${API_BASE}/health" >/dev/null 2>&1; then
      ok "API started at ${API_BASE} (pid ${API_PID})"
      break
    fi
    sleep 1
  done
  if ! curl -sS "${API_BASE}/health" >/dev/null 2>&1; then
    err "API failed to start. See /tmp/agentos-showcase-api.log"
    exit 1
  fi
fi

step "10) Authenticate demo user for API calls"
SIGNUP_JSON="$(curl -sS -X POST "${API_BASE}/api/v1/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${DEMO_EMAIL}\",\"password\":\"${DEMO_PASSWORD}\",\"name\":\"CLI Demo User\"}")"
AUTH_TOKEN="$(printf '%s' "${SIGNUP_JSON}" | json_field token)"
if [[ -z "${AUTH_TOKEN}" ]]; then
  warn "Signup did not return token; trying login"
  LOGIN_JSON="$(curl -sS -X POST "${API_BASE}/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${DEMO_EMAIL}\",\"password\":\"${DEMO_PASSWORD}\"}")"
  AUTH_TOKEN="$(printf '%s' "${LOGIN_JSON}" | json_field token)"
fi
if [[ -z "${AUTH_TOKEN}" ]]; then
  err "Could not obtain auth token for API demo."
  exit 1
fi
ok "Authenticated demo user ${DEMO_EMAIL}"

AUTH_HEADER="Authorization: Bearer ${AUTH_TOKEN}"

step "11) Memory API showcase (facts + episodes + views)"
run_or_warn "Upsert semantic fact" \
  bash -lc "curl -sS -X POST \"${API_BASE}/api/v1/memory/${AGENT_NAME}/facts?key=demo_status&value=ready_for_showcase\" -H \"${AUTH_HEADER}\""
run_or_warn "Create episodic memory" \
  bash -lc "curl -sS -X POST \"${API_BASE}/api/v1/memory/${AGENT_NAME}/episodes?input_text=demo%20input&output_text=demo%20output&outcome=success\" -H \"${AUTH_HEADER}\""
run_or_warn "List facts" \
  bash -lc "curl -sS \"${API_BASE}/api/v1/memory/${AGENT_NAME}/facts\" -H \"${AUTH_HEADER}\""
run_or_warn "List episodes" \
  bash -lc "curl -sS \"${API_BASE}/api/v1/memory/${AGENT_NAME}/episodes\" -H \"${AUTH_HEADER}\""
run_or_warn "Show working memory snapshot" \
  bash -lc "curl -sS \"${API_BASE}/api/v1/memory/${AGENT_NAME}/working\" -H \"${AUTH_HEADER}\""

step "12) Observability & compliance evidence (sessions/turns/runtime insights)"
run_or_warn "List recent sessions via API" \
  bash -lc "curl -sS \"${API_BASE}/api/v1/sessions?limit=5&offset=0\" -H \"${AUTH_HEADER}\""
run_or_warn "Runtime insights rollup (parallel/reflection/action telemetry)" \
  bash -lc "curl -sS \"${API_BASE}/api/v1/sessions/runtime/insights?since_days=30&limit_sessions=200\" -H \"${AUTH_HEADER}\""

LATEST_SESSION_ID="$(curl -sS \"${API_BASE}/api/v1/sessions?limit=1&offset=0\" -H \"${AUTH_HEADER}\" | python3 - <<'PY'
import json, sys
raw = sys.stdin.read()
try:
    data = json.loads(raw)
    if isinstance(data, list) and data:
        print(data[0].get("session_id", ""))
    else:
        print("")
except Exception:
    print("")
PY
)"
if [[ -n "${LATEST_SESSION_ID}" ]]; then
  run_or_warn "Latest session runtime profile" \
    bash -lc "curl -sS \"${API_BASE}/api/v1/sessions/${LATEST_SESSION_ID}/runtime\" -H \"${AUTH_HEADER}\""
  run_or_warn "Latest session turns" \
    bash -lc "curl -sS \"${API_BASE}/api/v1/sessions/${LATEST_SESSION_ID}/turns\" -H \"${AUTH_HEADER}\""
fi

run_or_warn "Direct DB counts for sessions/turns/spans" \
  python3 - <<'PY'
import sqlite3
from pathlib import Path
p = Path("data/agent.db")
conn = sqlite3.connect(p)
cur = conn.cursor()
for table in ("sessions", "turns", "spans", "billing_records"):
    try:
        c = cur.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"{table}: {c}")
    except Exception as exc:
        print(f"{table}: error ({exc})")
PY

step "13) Sandbox / E2B showcase"
if [[ -n "${E2B_API_KEY:-}" ]]; then
  SANDBOX_JSON="$(curl -sS -X POST "${API_BASE}/api/v1/sandbox/create?template=base&timeout_sec=300" -H "${AUTH_HEADER}")"
  SANDBOX_ID="$(printf '%s' "${SANDBOX_JSON}" | json_field sandbox_id)"
  if [[ -n "${SANDBOX_ID}" ]]; then
    ok "Created sandbox ${SANDBOX_ID}"
    run_or_warn "Run command in sandbox" \
      bash -lc "curl -sS -X POST \"${API_BASE}/api/v1/sandbox/exec?sandbox_id=${SANDBOX_ID}&command=python%20--version\" -H \"${AUTH_HEADER}\""
    run_or_warn "List sandbox files" \
      bash -lc "curl -sS \"${API_BASE}/api/v1/sandbox/${SANDBOX_ID}/files?path=/\" -H \"${AUTH_HEADER}\""
    run_or_warn "Kill sandbox" \
      bash -lc "curl -sS -X POST \"${API_BASE}/api/v1/sandbox/kill?sandbox_id=${SANDBOX_ID}\" -H \"${AUTH_HEADER}\""
  else
    warn "Sandbox create did not return sandbox_id. Response: ${SANDBOX_JSON}"
  fi
else
  warn "E2B_API_KEY is not set in this shell. Skipping live sandbox section."
fi

step "14) Release + canary lifecycle showcase"
PROMOTE_JSON="$(curl -sS -X POST \"${API_BASE}/api/v1/releases/${AGENT_NAME}/promote?from_channel=draft&to_channel=staging\" -H "${AUTH_HEADER}")"
run_or_warn "Promote draft -> staging" bash -lc "printf '%s\n' '${PROMOTE_JSON}'"
PROMOTED_VERSION="$(printf '%s' "${PROMOTE_JSON}" | json_field version)"
if [[ -z "${PROMOTED_VERSION}" ]]; then
  PROMOTED_VERSION="v0.1.0"
fi
run_or_warn "Set canary split (10%)" \
  bash -lc "curl -sS -X POST \"${API_BASE}/api/v1/releases/${AGENT_NAME}/canary?primary_version=${PROMOTED_VERSION}&canary_version=${PROMOTED_VERSION}-canary&canary_weight=0.1\" -H \"${AUTH_HEADER}\""
run_or_warn "Read canary status" \
  bash -lc "curl -sS \"${API_BASE}/api/v1/releases/${AGENT_NAME}/canary\" -H \"${AUTH_HEADER}\""
run_or_warn "Remove canary split" \
  bash -lc "curl -sS -X DELETE \"${API_BASE}/api/v1/releases/${AGENT_NAME}/canary\" -H \"${AUTH_HEADER}\""

step "15) Architecture visibility: codemap JSON + SVG"
run_or_warn "Generate codemap (JSON + SVG)" \
  bash -lc "${CLI} codemap --root . --json-out data/demo-codemap.json --svg-out docs/codemap.svg"

step "16) Showcase complete"
ok "Agent created: ${AGENT_NAME}"
ok "Deploy scaffold: deploy/agent-config.json"
ok "Evolution export: data/demo-evolve.json"
ok "Codemap JSON: data/demo-codemap.json"
ok "Codemap SVG: docs/codemap.svg"
info "If API was started by this script, it will be stopped automatically."

