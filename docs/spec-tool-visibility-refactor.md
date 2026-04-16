# Tool Visibility Refactor — Spec & Implementation Plan

## Problem

Every tool call renders as an identical collapsible dropdown (`CollapsibleBlock`). A 50ms `memory-recall` looks the same as a 46s `swarm`. Arguments and results are hidden by default. The user has to click each dropdown to understand what the agent did.

Compare with Claude Code's CLI: tool calls render inline, compact, with per-tool formatting — file edits show diffs, searches show result counts, errors are visible without clicking.

## Current Architecture

```
ChatMessage.svelte
  └─ CollapsibleBlock (thinking/reasoning)
  └─ ToolCallBlock (for each tool call)
       └─ CollapsibleBlock (uniform wrapper)
            ├─ Arguments (JSON, always hidden)
            ├─ Edit Preview (diff, only for edit/write tools)
            ├─ Error (red text)
            ├─ Result (monospace text, truncated at 5000 chars)
            └─ Pending ("Waiting for result...")
```

**Files:**
- `ui/src/lib/components/chat/ChatMessage.svelte` — message renderer (~480 lines)
- `ui/src/lib/components/chat/ToolCallBlock.svelte` — tool call display (~403 lines)
- `ui/src/lib/components/chat/CollapsibleBlock.svelte` — generic collapsible (~137 lines)

**Tech stack:** Svelte 5 (runes) + SvelteKit 2 + Tailwind CSS 4 + bits-ui

## Design Principles

1. **Inline by default, expandable on demand** — tool calls show a compact one-liner with key info visible. Click to expand full details.
2. **Per-tool rendering** — different tools show different summaries (search shows query + result count, file edit shows path + diff stats, swarm shows task count + progress).
3. **Progressive disclosure** — pending tools show a spinner + tool name. Completed tools show a one-line summary. Expanded view shows full arguments + result.
4. **Visual hierarchy** — tool name is the anchor. Status (spinner/checkmark/error) is the first signal. Summary text gives context without expanding.
5. **No dropdowns for simple tools** — tools like `memory-recall` that return a short result should show it inline without requiring a click.

## Target Architecture

```
ChatMessage.svelte
  └─ ThinkingBlock (reasoning, still collapsible)
  └─ ToolCallGroup (groups concurrent tool calls in one visual block)
       └─ ToolCallInline (per-tool, compact one-liner)
            ├─ StatusIcon (spinner | checkmark | error)
            ├─ ToolName (monospace, always visible)
            ├─ Summary (per-tool, derived from args + result)
            ├─ Latency (small, dimmed)
            └─ ExpandedDetail (click to toggle)
                 ├─ Arguments (syntax highlighted)
                 ├─ Result (formatted per tool type)
                 └─ Error (inline red text)
```

### New Components

| Component | Purpose | Replaces |
|-----------|---------|----------|
| `ToolCallInline.svelte` | Compact one-line tool display with expandable detail | `ToolCallBlock.svelte` |
| `ToolCallGroup.svelte` | Groups concurrent calls (same turn) with shared timing | Turn grouping in `ChatMessage.svelte` |
| `toolSummary.ts` | Per-tool summary extraction (pure functions) | Inline logic in `ToolCallBlock` |

### `CollapsibleBlock.svelte` — Keep

Still used for thinking/reasoning blocks. Not used for tool calls anymore.

## Per-Tool Summary Rules

The `toolSummary.ts` module maps tool name → summary extractor. Each extractor receives `(args, result, error)` and returns a one-line string.

| Tool | Pending Summary | Completed Summary |
|------|----------------|-------------------|
| `web-search` | `searching "query..."` | `3 results for "query..."` |
| `browse` | `loading example.com` | `loaded example.com (2.1s)` |
| `python-exec` | `running python...` | `exit 0` or `exit 1: error msg` |
| `bash` | `$ command...` | `exit 0` or `exit 1: error msg` |
| `memory-save` | `saving "key"` | `saved "key" (project)` |
| `memory-recall` | `recalling "query"` | `3 facts found` or `no facts found` |
| `read-file` | `reading path/file.ts` | `read 142 lines` |
| `write-file` | `writing path/file.ts` | `wrote 2.1 KB to path/file.ts` |
| `edit-file` | `editing path/file.ts` | `+5 -3 in path/file.ts` (inline diff preview) |
| `execute-code` | `executing code...` | `completed (1.2s)` or `error: msg` |
| `swarm` | `running 4 tasks...` | `4/4 passed (46.3s)` or `3/4 passed, 1 failed` |
| `knowledge-search` | `searching knowledge base...` | `5 chunks found` |
| `run-agent` | `delegating to agent-name...` | `agent-name completed` |
| `create-schedule` | `creating schedule...` | `scheduled: cron expression` |
| `web-crawl` | `crawling example.com...` | `crawled 12 pages` |
| `image-generate` | `generating image...` | `image generated` (show thumbnail) |
| (default) | `tool-name executing...` | `tool-name completed (1.2s)` |

## Visual States

### Pending (streaming)
```
[spinner] web-search  searching "AI agent frameworks 2026"
```

### Completed (success)
```
[checkmark] web-search  3 results for "AI agent frameworks 2026"  180ms
```
Click expands to show full arguments + result.

### Completed (error)
```
[x-icon] execute-code  error: Tool "webSearch" not found  8ms
```
Error text is visible inline — no click needed.

### Expanded (any state)
```
[checkmark] web-search  3 results for "AI agent frameworks 2026"  180ms
  ┌─ Arguments ──────────────────────────────────┐
  │ { "query": "AI agent frameworks 2026" }      │
  └──────────────────────────────────────────────┘
  ┌─ Result ─────────────────────────────────────┐
  │ [1] Microsoft AutoGen - multi-agent...       │
  │ [2] LangGraph - stateful agent graphs...     │
  │ [3] CrewAI - role-based collaboration...     │
  └──────────────────────────────────────────────┘
```

### Tool Group (concurrent calls)
```
  [checkmark] web-search  3 results for "AutoGen features"       1.2s
  [checkmark] web-search  5 results for "CrewAI capabilities"    1.4s
  [checkmark] web-search  2 results for "LangGraph deployment"   0.9s
  ─── 3 tools  1.4s total ───
```

### Edit Preview (special rendering for file tools)
```
[checkmark] edit-file  +12 -3 in src/runtime/tools.ts  45ms
```
Expanded shows the diff with green/red lines (already implemented, just move inline).

### Swarm (special rendering)
```
[spinner] swarm  running 4 tasks...  [=====>    ] 2/4
```
When complete:
```
[checkmark] swarm  4/4 passed  46.3s
```
Expandable to show individual task results.

## Implementation Plan

### Phase 1: `toolSummary.ts` — Pure logic (no UI)
- Create `ui/src/lib/components/chat/toolSummary.ts`
- Implement `getToolSummary(name, args, result, error): { pending: string; completed: string }`
- Unit test with vitest for each tool type
- **Estimated scope:** ~150 lines + ~100 lines tests

### Phase 2: `ToolCallInline.svelte` — New compact component
- Create the inline component that replaces `ToolCallBlock`
- Render: `[icon] name  summary  latency`
- Click toggles expanded detail (arguments + result)
- Keep edit preview, media preview, image display from existing `ToolCallBlock`
- **Estimated scope:** ~250 lines (simpler than current 403-line `ToolCallBlock`)

### Phase 3: `ToolCallGroup.svelte` — Turn grouping
- Replace the turn grouping logic in `ChatMessage.svelte`
- Renders a visual group with shared timing footer
- **Estimated scope:** ~60 lines

### Phase 4: Wire into `ChatMessage.svelte`
- Replace `ToolCallBlock` imports with `ToolCallInline` / `ToolCallGroup`
- Remove turn grouping logic from ChatMessage (moved to ToolCallGroup)
- Keep `CollapsibleBlock` for thinking/reasoning only
- **Estimated scope:** ~30 lines changed in ChatMessage

### Phase 5: Polish & edge cases
- Swarm progress bar (if heartbeat events are available via WebSocket)
- Image thumbnails for `image-generate` results
- Long error messages: show first line inline, full text on expand
- Keyboard navigation (arrow keys to move between tool calls)
- Animation: smooth expand/collapse transition

## Migration Strategy

- `ToolCallBlock.svelte` is NOT deleted — renamed to `ToolCallBlock.legacy.svelte`
- New `ToolCallInline.svelte` is the default
- Feature flag in the component: `const USE_INLINE = true` — flip to false to revert
- After validation, delete legacy component

## Files Changed

| File | Action |
|------|--------|
| `ui/src/lib/components/chat/toolSummary.ts` | **New** — per-tool summary extraction |
| `ui/src/lib/components/chat/ToolCallInline.svelte` | **New** — compact inline tool display |
| `ui/src/lib/components/chat/ToolCallGroup.svelte` | **New** — turn grouping component |
| `ui/src/lib/components/chat/ChatMessage.svelte` | **Edit** — use new components |
| `ui/src/lib/components/chat/ToolCallBlock.svelte` | **Rename** → `ToolCallBlock.legacy.svelte` |
| `ui/src/lib/components/chat/CollapsibleBlock.svelte` | **No change** — still used for thinking |
| `ui/test/toolSummary.test.ts` | **New** — unit tests for summary extraction |

## Non-Goals

- Redesigning the overall chat layout or message bubbles
- Changing the thinking/reasoning block display
- Modifying the WebSocket streaming protocol
- Adding new tool call data to the API response format
