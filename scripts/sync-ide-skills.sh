#!/usr/bin/env bash
# Copy project Cursor skills (.cursor/skills) into Claude Code (.claude/skills).
# Run from repo root: ./scripts/sync-ide-skills.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.cursor/skills"
DST="$ROOT/.claude/skills"
mkdir -p "$DST"
rsync -a "$SRC/" "$DST/"
echo "Synced IDE skills: $SRC -> $DST"
