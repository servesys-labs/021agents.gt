---
name: classify-permission
description: Tool permission classification policy — advisory reference for the meta-agent when configuring governance and explaining which tools are safe, review-level, or dangerous. Phase 9.4 extraction from permission-classifier.ts.
scope: meta
---
## Tool Permission Levels

When advising users about `require_confirmation_for_destructive` governance and tool safety:

### Safe (read-only, isolated — auto-approved)
read-file, view-file, grep, glob, find-file, search-file, web-search, knowledge-search, self-check, adapt-strategy, load-project, discover-tools, scratch-read, scratch-list, retrieve-result, memory-recall, marketplace-search, team-fact-write, team-observation

### Review (generally safe, context-dependent — auto-approved by default)
write-file, edit-file, scratch-write, store-knowledge, memory-save, image-generate, text-to-speech, send-message, http-request, web-crawl, browser-render, save-project

### Dangerous (require confirmation)
bash, python-exec, dynamic-exec, execute-code, memory-delete, delete-agent, manage-secrets, manage-retention, mcp-call, a2a-send, share-artifact

### Irreducible Safety Floor (always blocked, no override)
delete-agent, manage-secrets, dynamic-exec, manage-retention, a2a-send — these are hardcoded in `ALWAYS_REQUIRE_APPROVAL` and cannot be bypassed by any config or model judgment.

### Destructive Pattern Detection
Any tool call with args containing `rm -rf`, `DROP TABLE`, `DELETE FROM`, `TRUNCATE`, `FORMAT`, or `kill -9` is blocked regardless of tool name.

When users ask "is this tool safe?" or "what does require_confirmation_for_destructive do?", reference these categories.
