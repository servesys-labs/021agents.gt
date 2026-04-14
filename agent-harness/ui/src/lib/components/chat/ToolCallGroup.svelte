<script lang="ts">
  import ToolCallInline from "./ToolCallInline.svelte";
  import { getToolSummary } from "./toolSummary";

  interface ToolCall {
    name: string;
    input: string;
    output?: string;
    call_id: string;
    latency_ms?: number;
    error?: string;
  }

  interface Props {
    toolCalls: ToolCall[];
    agentName?: string;
    /** Show as compact task list with checkmarks (Claude Code style) */
    compact?: boolean;
  }

  let { toolCalls, agentName, compact = false }: Props = $props();

  let completed = $derived(toolCalls.filter(tc => tc.output || tc.error).length);
  let total = $derived(toolCalls.length);
  let allDone = $derived(completed === total && total > 0);

  // Expanded state for the group
  let expanded = $state(false);
</script>

{#if compact && toolCalls.length > 1}
  <!-- Compact task list mode (Claude Code / Manus style) -->
  <div class="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
    <!-- Summary header (clickable to expand) -->
    <button
      class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/30 transition-colors"
      onclick={() => (expanded = !expanded)}
    >
      {#if allDone}
        <span class="flex h-4 w-4 items-center justify-center rounded-full bg-green-500/20 text-green-500 text-[10px]">✓</span>
      {:else}
        <span class="flex h-4 w-4 items-center justify-center">
          <span class="h-3 w-3 rounded-full border-2 border-primary border-t-transparent animate-spin"></span>
        </span>
      {/if}
      <span class="font-medium text-foreground">
        {#if allDone}
          Completed {total} task{total > 1 ? 's' : ''}
        {:else}
          Running {total} task{total > 1 ? 's' : ''} in parallel
        {/if}
      </span>
      <span class="ml-auto text-muted-foreground/50">{completed}/{total}</span>
      <span class="text-muted-foreground/40">{expanded ? '▲' : '▼'}</span>
    </button>

    <!-- Task list (always visible as checklist, expandable for details) -->
    <div class="border-t border-border/30 px-3 py-1.5 space-y-1">
      {#each toolCalls as tc (tc.call_id)}
        {@const isDone = !!(tc.output || tc.error)}
        {@const hasError = !!tc.error}
        {@const summary = getToolSummary(tc.name, tc.input, tc.output)}
        <div class="flex items-start gap-2 py-0.5">
          <!-- Checkmark / spinner / error -->
          {#if hasError}
            <span class="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[9px] text-red-400">✕</span>
          {:else if isDone}
            <span class="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm bg-green-500/20 text-[9px] text-green-500">✓</span>
          {:else}
            <span class="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              <span class="h-2.5 w-2.5 rounded-full border border-primary/50 border-t-transparent animate-spin"></span>
            </span>
          {/if}
          <!-- Task description -->
          <div class="flex-1 min-w-0">
            <span class="text-[11px] {isDone ? 'text-muted-foreground' : 'text-foreground'} {hasError ? 'line-through text-red-400/70' : ''}">
              {summary}
            </span>
            {#if tc.latency_ms && isDone}
              <span class="text-[9px] text-muted-foreground/40 ml-1">{tc.latency_ms}ms</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    <!-- Expanded details -->
    {#if expanded}
      <div class="border-t border-border/30 p-2 space-y-1">
        {#each toolCalls as tc (tc.call_id)}
          <ToolCallInline toolCall={tc} {agentName} />
        {/each}
      </div>
    {/if}
  </div>
{:else}
  <!-- Standard mode: each tool call rendered individually -->
  {#each toolCalls as tc (tc.call_id)}
    <ToolCallInline toolCall={tc} {agentName} />
  {/each}
{/if}
