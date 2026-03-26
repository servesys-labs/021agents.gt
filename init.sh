#!/usr/bin/env bash
# init.sh — AgentOS dev environment bootstrap
#
# Run this at the start of every development session to ensure all
# dependencies are installed, type-checks pass, and the environment
# is ready for work.
#
# Usage:
#   ./init.sh          # Full bootstrap (install + verify)
#   ./init.sh --quick  # Skip installs, just verify

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; ERRORS=$((ERRORS + 1)); }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
ERRORS=0

echo "━━━ AgentOS Dev Environment Bootstrap ━━━"
echo ""

# ── Prerequisites ──────────────────────────────────────────────
echo "Checking prerequisites..."

command -v node >/dev/null 2>&1 && ok "node $(node -v)" || fail "node not found"
command -v npm >/dev/null 2>&1  && ok "npm $(npm -v)"   || fail "npm not found"

if command -v wrangler >/dev/null 2>&1; then
  ok "wrangler available"
else
  warn "wrangler not found globally (will use npx)"
fi

# ── Install Dependencies ──────────────────────────────────────
if [[ "${1:-}" != "--quick" ]]; then
  echo ""
  echo "Installing dependencies..."

  echo "  control-plane/"
  (cd "$ROOT_DIR/control-plane" && npm install --silent 2>&1) && ok "control-plane deps" || fail "control-plane npm install"

  echo "  deploy/"
  (cd "$ROOT_DIR/deploy" && npm install --silent 2>&1) && ok "deploy deps" || fail "deploy npm install"

  echo "  portal/"
  (cd "$ROOT_DIR/portal" && npm install --silent 2>&1) && ok "portal deps" || fail "portal npm install"
fi

# ── Type Checks ────────────────────────────────────────────────
echo ""
echo "Running type checks..."

(cd "$ROOT_DIR/portal" && npx tsc -b --pretty false 2>&1 | tail -5) && ok "portal typecheck" || warn "portal typecheck has errors"

# ── Tests (control-plane only — fast) ─────────────────────────
echo ""
echo "Running control-plane tests..."

if (cd "$ROOT_DIR/control-plane" && npx vitest run --reporter=dot 2>&1 | tail -3); then
  ok "control-plane tests pass"
else
  warn "control-plane tests have failures (check output above)"
fi

# ── Verify Key Files ──────────────────────────────────────────
echo ""
echo "Verifying project structure..."

[[ -f "$ROOT_DIR/feature_list.json" ]]              && ok "feature_list.json exists"   || fail "feature_list.json missing"
[[ -f "$ROOT_DIR/claude-progress.txt" ]]             && ok "claude-progress.txt exists" || fail "claude-progress.txt missing"
[[ -f "$ROOT_DIR/AGENTS.md" ]]                       && ok "AGENTS.md exists"           || fail "AGENTS.md missing"
[[ -f "$ROOT_DIR/control-plane/src/index.ts" ]]      && ok "control-plane entry point"  || fail "control-plane/src/index.ts missing"
[[ -f "$ROOT_DIR/deploy/src/index.ts" ]]             && ok "deploy entry point"         || fail "deploy/src/index.ts missing"
[[ -f "$ROOT_DIR/portal/src/App.tsx" ]]              && ok "portal entry point"         || fail "portal/src/App.tsx missing"

# ── Summary ────────────────────────────────────────────────────
echo ""
if [[ $ERRORS -eq 0 ]]; then
  echo -e "${GREEN}━━━ Environment ready. $ERRORS errors. ━━━${NC}"
else
  echo -e "${RED}━━━ Environment has $ERRORS error(s). Fix before proceeding. ━━━${NC}"
fi
echo ""
echo "Next steps:"
echo "  1. Read claude-progress.txt for session context"
echo "  2. Read feature_list.json for feature status"
echo "  3. Start dev servers:"
echo "     cd control-plane && npm run dev   # API on :8787"
echo "     cd deploy && npm run dev          # Runtime on :8788"
echo "     cd portal && npm run dev          # UI on :5173"

exit $ERRORS
