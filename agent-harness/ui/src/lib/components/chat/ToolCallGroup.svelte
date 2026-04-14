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
  // Per-phase expanded state
  let expandedPhases = $state<Set<string>>(new Set());

  // ── Phase detection: group sequential tool calls into named phases ──
  interface Phase {
    id: string;
    label: string;
    icon: string;
    tools: ToolCall[];
  }

  // Map tool names to phase categories
  function getPhaseInfo(toolName: string): { label: string; icon: string; order: number } {
    const name = toolName.toLowerCase();
    if (name.includes("search") || name.includes("browse") || name.includes("web")) {
      return { label: "Research", icon: "🔍", order: 1 };
    }
    if (name.includes("read") || name.includes("knowledge") || name.includes("memory-recall")) {
      return { label: "Reading", icon: "📖", order: 2 };
    }
    if (name.includes("python") || name.includes("execute") || name.includes("bash") || name.includes("code")) {
      return { label: "Computing", icon: "⚙️", order: 3 };
    }
    if (name.includes("write") || name.includes("edit") || name.includes("create")) {
      return { label: "Writing", icon: "✏️", order: 4 };
    }
    if (name.includes("agent") || name.includes("swarm") || name.includes("delegate")) {
      return { label: "Delegating", icon: "🤝", order: 5 };
    }
    if (name.includes("memory-save") || name.includes("schedule")) {
      return { label: "Saving", icon: "💾", order: 6 };
    }
    return { label: "Processing", icon: "🔧", order: 7 };
  }

  // Group tool calls into phases (sequential clusters of same-category tools)
  let phases = $derived.by(() => {
    if (toolCalls.length <= 2) return []; // Don't phase small groups

    const result: Phase[] = [];
    let currentPhase: Phase | null = null;

    for (const tc of toolCalls) {
      const info = getPhaseInfo(tc.name);
      if (!currentPhase || currentPhase.label !== info.label) {
        currentPhase = {
          id: `phase-${result.length}`,
          label: info.label,
          icon: info.icon,
          tools: [tc],
        };
        result.push(currentPhase);
      } else {
        currentPhase.tools.push(tc);
      }
    }

    // Only return phases if there are multiple (otherwise flat list is better)
    return result.length >= 2 ? result : [];
  });

  function togglePhase(id: string) {
    const next = new Set(expandedPhases);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedPhases = next;
  }

  function phaseCompleted(phase: Phase): number {
    return phase.tools.filter(tc => tc.output || tc.error).length;
  }

  function phaseAllDone(phase: Phase): boolean {
    return phaseCompleted(phase) === phase.tools.length && phase.tools.length > 0;
  }

  function phaseHasError(phase: Phase): boolean {
    return phase.tools.some(tc => tc.error);
  }
</script>

{#if compact && toolCalls.length > 1}
  <!-- Compact task list mode -->
  <div class="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
    <!-- Summary header -->
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
          Running {total} task{total > 1 ? 's' : ''}{total > 1 ? ' in parallel' : ''}
        {/if}
      </span>
      <span class="ml-auto text-muted-foreground/50">{completed}/{total}</span>
      <span class="text-muted-foreground/40">{expanded ? '▲' : '▼'}</span>
    </button>

    <!-- Phased view (Perplexity-style nested groups) -->
    {#if phases.length >= 2}
      <div class="border-t border-border/30">
        {#each phases as phase (phase.id)}
          {@const pDone = phaseAllDone(phase)}
          {@const pError = phaseHasError(phase)}
          {@const pExpanded = expandedPhases.has(phase.id)}

          <!-- Phase header -->
          <button
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] hover:bg-muted/20 transition-colors border-b border-border/20"
            onclick={() => togglePhase(phase.id)}
          >
            {#if pError}
              <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[9px] text-red-400">✕</span>
            {:else if pDone}
              <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm bg-green-500/15 text-[9px] text-green-500">✓</span>
            {:else}
              <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                <span class="h-2.5 w-2.5 rounded-full border border-primary/50 border-t-transparent animate-spin"></span>
              </span>
            {/if}
            <span class="text-[10px]">{phase.icon}</span>
            <span class="font-medium {pDone ? 'text-muted-foreground' : 'text-foreground'}">{phase.label}</span>
            <span class="text-[9px] text-muted-foreground/50">{phaseCompleted(phase)}/{phase.tools.length}</span>
            <span class="ml-auto text-muted-foreground/30 text-[9px]">{pExpanded ? '▲' : '▼'}</span>
          </button>

          <!-- Phase tasks (expanded) -->
          {#if pExpanded}
            <div class="px-3 py-1 space-y-0.5 bg-muted/10">
              {#each phase.tools as tc (tc.call_id)}
                {@const isDone = !!(tc.output || tc.error)}
                {@const hasError = !!tc.error}
                {@const summary = getToolSummary(tc.name, tc.input, tc.output)}
                <div class="flex items-start gap-2 py-0.5 pl-4">
                  {#if hasError}
                    <span class="mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center text-[8px] text-red-400">✕</span>
                  {:else if isDone}
                    <span class="mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center text-[8px] text-green-500">✓</span>
                  {:else}
                    <span class="mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center">
                      <span class="h-2 w-2 rounded-full border border-primary/40 border-t-transparent animate-spin"></span>
                    </span>
                  {/if}
                  <span class="text-[10px] {isDone ? 'text-muted-foreground' : 'text-foreground'} {hasError ? 'line-through text-red-400/70' : ''} truncate">
                    {summary}
                  </span>
                  {#if tc.latency_ms && isDone}
                    <span class="text-[8px] text-muted-foreground/40 shrink-0">{tc.latency_ms}ms</span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        {/each}
      </div>

    {:else}
      <!-- Flat task list (few items or single-phase) -->
      <div class="border-t border-border/30 px-3 py-1.5 space-y-1">
        {#each toolCalls as tc (tc.call_id)}
          {@const isDone = !!(tc.output || tc.error)}
          {@const hasError = !!tc.error}
          {@const summary = getToolSummary(tc.name, tc.input, tc.output)}
          <div class="flex items-start gap-2 py-0.5">
            {#if hasError}
              <span class="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[9px] text-red-400">✕</span>
            {:else if isDone}
              <span class="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm bg-green-500/20 text-[9px] text-green-500">✓</span>
            {:else}
              <span class="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                <span class="h-2.5 w-2.5 rounded-full border border-primary/50 border-t-transparent animate-spin"></span>
              </span>
            {/if}
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
    {/if}

    <!-- Expanded full details -->
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
