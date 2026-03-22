#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUN_TESTS=1
RUN_DEPLOY_TYPES=1
QUICK=0
SMOKE_URL=""
SMOKE_TOKEN=""

RED="$(printf '\033[31m')"
GREEN="$(printf '\033[32m')"
YELLOW="$(printf '\033[33m')"
BOLD="$(printf '\033[1m')"
RESET="$(printf '\033[0m')"

ok() { printf "%s[ok]%s %s\n" "$GREEN" "$RESET" "$*"; }
warn() { printf "%s[warn]%s %s\n" "$YELLOW" "$RESET" "$*"; }
err() { printf "%s[err]%s %s\n" "$RED" "$RESET" "$*"; }

usage() {
  cat <<'EOF'
Usage: scripts/prod_check.sh [options]

Options:
  --quick                 Run a shorter validation set.
  --skip-tests            Skip pytest checks.
  --skip-deploy-types     Skip deploy TypeScript checks.
  --smoke-url URL         Run basic smoke checks against URL.
  --token TOKEN           Bearer token for smoke checks.
  -h, --help              Show this help.

Examples:
  scripts/prod_check.sh
  scripts/prod_check.sh --quick
  scripts/prod_check.sh --smoke-url "https://example.workers.dev" --token "$TOKEN"
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --skip-tests) RUN_TESTS=0 ;;
    --skip-deploy-types) RUN_DEPLOY_TYPES=0 ;;
    --smoke-url) SMOKE_URL="${2:-}"; shift ;;
    --token) SMOKE_TOKEN="${2:-}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown argument: $1"; usage; exit 1 ;;
  esac
  shift
done

printf "\n%sAgentOS Production Preflight%s\n\n" "$BOLD" "$RESET"

command -v git >/dev/null || { err "git not found"; exit 1; }
command -v python3 >/dev/null || { err "python3 not found"; exit 1; }

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ -n "$(git status --porcelain)" ]]; then
    warn "Working tree is not clean."
  else
    ok "Working tree is clean."
  fi
fi

required_env=(
  "AGENTOS_AUTH_REQUIRED"
  "AGENTOS_JWT_SECRET"
  "AGENTOS_SECRET_ENCRYPTION_KEY"
)
missing_env=0
for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    err "Missing required env var: $name"
    missing_env=1
  else
    ok "Found env var: $name"
  fi
done

if [[ -n "${AGENTOS_JWT_SECRET:-}" && -n "${AGENTOS_SECRET_ENCRYPTION_KEY:-}" ]]; then
  if [[ "${AGENTOS_JWT_SECRET}" == "${AGENTOS_SECRET_ENCRYPTION_KEY}" ]]; then
    err "AGENTOS_JWT_SECRET and AGENTOS_SECRET_ENCRYPTION_KEY must differ."
    missing_env=1
  else
    ok "JWT and encryption secrets are distinct."
  fi
fi

if [[ "$missing_env" -ne 0 ]]; then
  err "Environment validation failed."
  exit 1
fi

if [[ "$RUN_TESTS" -eq 1 ]]; then
  PYTEST_BIN="python3 -m pytest"
  if [[ -x ".venv/bin/python" ]]; then
    PYTEST_BIN=".venv/bin/python -m pytest"
    ok "Using virtualenv pytest runner."
  else
    warn "No .venv found; using system pytest."
  fi

  if [[ "$QUICK" -eq 1 ]]; then
    $PYTEST_BIN tests/test_security_auth_tenant_regressions.py tests/test_recent_commit_regressions.py -q
    ok "Quick security/regression tests passed."
  else
    $PYTEST_BIN -q
    ok "Full test suite passed."
  fi
fi

python3 -m compileall agentos >/dev/null
ok "Python compileall passed."

if [[ "$RUN_DEPLOY_TYPES" -eq 1 ]]; then
  if [[ -f "deploy/package.json" ]]; then
    if command -v npm >/dev/null; then
      if grep -q '"types"' deploy/package.json; then
        (cd deploy && npm run types >/dev/null)
        ok "Deploy type generation passed."
      else
        warn "No deploy 'types' script found; skipping."
      fi
    else
      warn "npm not found; skipping deploy type checks."
    fi
  fi
fi

if [[ -n "$SMOKE_URL" ]]; then
  command -v curl >/dev/null || { err "curl required for smoke checks"; exit 1; }
  ok "Running smoke checks against $SMOKE_URL"
  curl -fsS "$SMOKE_URL/health" >/dev/null
  ok "Health endpoint reachable."

  if [[ -n "$SMOKE_TOKEN" ]]; then
    curl -fsS -X POST "$SMOKE_URL/run" \
      -H "Authorization: Bearer $SMOKE_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"input":"smoke test"}' >/dev/null
    ok "Authenticated /run smoke passed."
  else
    warn "No --token supplied; skipped authenticated /run smoke check."
  fi
fi

printf "\n%sPreflight completed successfully.%s\n" "$GREEN" "$RESET"
