#!/bin/bash
# Upload all skills from skills/ directory to R2 STORAGE bucket.
# Run from agent-harness/ directory.
# Usage: ./scripts/upload-skills.sh [--remote]

set -e

REMOTE_FLAG="${1:---remote}"
SKILLS_DIR="$(dirname "$0")/../skills"
BUCKET="STORAGE"

echo "Uploading skills to R2 bucket: $BUCKET"
echo "Skills directory: $SKILLS_DIR"
echo ""

upload_count=0

# Upload public skills
for skill_dir in "$SKILLS_DIR"/public/*/; do
  skill_name=$(basename "$skill_dir")

  # Upload all files recursively
  find "$skill_dir" -type f | while read -r file; do
    relative="${file#$skill_dir}"
    r2_key="skills/public/$skill_name/$relative"
    echo "  -> $r2_key"
    npx wrangler r2 object put "$BUCKET/$r2_key" --file "$file" $REMOTE_FLAG 2>/dev/null
    upload_count=$((upload_count + 1))
  done
done

# Upload meta skills
for skill_dir in "$SKILLS_DIR"/meta/*/; do
  [ -d "$skill_dir" ] || continue
  skill_name=$(basename "$skill_dir")

  find "$skill_dir" -type f | while read -r file; do
    relative="${file#$skill_dir}"
    r2_key="skills/meta/$skill_name/$relative"
    echo "  -> $r2_key"
    npx wrangler r2 object put "$BUCKET/$r2_key" --file "$file" $REMOTE_FLAG 2>/dev/null
  done
done

echo ""
echo "Done. Skills uploaded to R2."
