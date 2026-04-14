<script lang="ts">
  import type { TestRunStore } from "$lib/stores/test-run.svelte";
  import type { CanvasStore } from "$lib/stores/canvas.svelte";
  import { fetchBreakers, type BreakersSnapshot, type BreakerState } from "$lib/services/breakers";
  import { onMount, onDestroy } from "svelte";

  interface Props {
    runStore: TestRunStore;
    canvasStore: CanvasStore;
  }

  let { runStore, canvasStore }: Props = $props();

  // Status bar polls breakers independently of the LiveStatsPanel because
  // it needs to render even when the panel is collapsed/hidden. Cached
  // shared snapshots from the runtime endpoint are cheap (~5ms), and the
  // browser dedupes overlapping requests via HTTP cache, so the duplication
  // is OK in practice. If it becomes noisy, lift to a singleton store.
  let breakersSnapshot = $state<BreakersSnapshot | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let copied = $state(false);

  async function refreshBreakers() {
    try {
      breakersSnapshot = await fetchBreakers();
    } catch {
      // Status bar is best-effort — silent failure is fine
    }
  }

  onMount(() => {
    refreshBreakers();
    pollTimer = setInterval(refreshBreakers, 15_000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  async function copySession() {
    if (!runStore.sessionId) return;
    try {
      await navigator.clipboard.writeText(runStore.sessionId);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // ignore
    }
  }

  function fmtCost(usd: number): string {
    if (usd === 0) return "$0.00";
    if (usd < 0.001) return "<$0.001";
    return `$${usd.toFixed(3)}`;
  }

  function breakerDot(state: BreakerState | undefined): string {
    switch (state) {
      case "closed":
        return "bg-emerald-500";
      case "half-open":
        return "bg-amber-500";
      case "open":
        return "bg-destructive";
      default:
        return "bg-muted-foreground/40";
    }
  }

  // Save state derivation — replaces the standalone Save button text since
  // the bottom bar is now the canonical home for canvas state.
  let saveState = $derived(
    canvasStore.saving
      ? "saving"
      : canvasStore.dirty
        ? "unsaved"
        : "saved",
  );
</script>

<div
  class="pointer-events-auto flex h-7 items-center gap-3 border-t border-border bg-card/95 px-3 text-[10px] text-muted-foreground backdrop-blur-sm"
>
  <!-- Save state — leftmost, like VS Code -->
  <div class="flex items-center gap-1.5">
    {#if saveState === "saving"}
      <span class="h-2 w-2 animate-spin rounded-full border border-foreground border-t-transparent"></span>
      <span>Saving</span>
    {:else if saveState === "unsaved"}
      <span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span>
      <span class="text-amber-500">Unsaved</span>
    {:else}
      <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
      <span>Saved</span>
    {/if}
  </div>

  <span class="text-muted-foreground/30">·</span>

  <!-- Agent name + plan -->
  <div class="flex items-center gap-1.5">
    <span class="font-mono text-foreground/80">{canvasStore.agentName}</span>
    <span class="rounded-sm bg-muted/60 px-1 text-[9px]">{canvasStore.plan}</span>
  </div>

  <span class="text-muted-foreground/30">·</span>

  <!-- Run state — only meaningful during/after a run -->
  {#if runStore.status === "running"}
    <div class="flex items-center gap-1.5">
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"></span>
      <span class="text-primary">Live</span>
      <span class="text-muted-foreground/40">·</span>
      <!-- Show the current step name first (always meaningful) -->
      {#if runStore.currentStepId}
        <span class="font-mono text-muted-foreground/70 capitalize">
          {runStore.currentStepId}
        </span>
      {/if}
      <!-- Then the most useful side-detail for the current state:
           tool count + active tool when tools are firing,
           model name when LLM is running, otherwise nothing. -->
      {#if runStore.totals.toolCalls > 0}
        <span class="font-mono text-emerald-400">
          {runStore.totals.toolCalls} tool{runStore.totals.toolCalls === 1 ? "" : "s"}
        </span>
        {#if runStore.activeToolName}
          <span class="font-mono text-muted-foreground/70 truncate max-w-[120px]" title={runStore.activeToolName}>
            {runStore.activeToolName}
          </span>
        {/if}
      {:else if runStore.modelUsed && runStore.currentStepId === "llm"}
        <span class="font-mono text-muted-foreground/50 truncate max-w-[120px]" title={runStore.modelUsed}>
          {runStore.modelUsed.split("/").pop()}
        </span>
      {/if}
    </div>
  {:else if runStore.totals.turns > 0}
    <!-- Post-run summary — turns, tool calls, cost -->
    <div class="flex items-center gap-1.5">
      <span class="font-mono text-foreground/70">{runStore.totals.turns} turn{runStore.totals.turns === 1 ? "" : "s"}</span>
      <span class="text-muted-foreground/40">·</span>
      <span class="font-mono text-foreground/70">{runStore.totals.toolCalls} tool{runStore.totals.toolCalls === 1 ? "" : "s"}</span>
      <span class="text-muted-foreground/40">·</span>
      <span class="font-mono text-foreground/70">{fmtCost(runStore.totals.costUsd)}</span>
    </div>
  {:else}
    <span class="italic text-muted-foreground/60">no runs this session</span>
  {/if}

  <!-- Spacer -->
  <div class="flex-1"></div>

  <!-- Session ID — clickable to copy -->
  {#if runStore.sessionId}
    <button
      type="button"
      class="flex items-center gap-1 rounded px-1 py-0.5 font-mono transition-colors hover:bg-accent hover:text-foreground"
      onclick={copySession}
      title="Click to copy session ID"
    >
      <span class="text-muted-foreground/60">session</span>
      <span class="text-foreground/80">{runStore.sessionId.slice(0, 8)}</span>
      {#if copied}
        <svg xmlns="http://www.w3.org/2000/svg" class="h-2.5 w-2.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      {/if}
    </button>

    <span class="text-muted-foreground/30">·</span>
  {/if}

  <!-- Breaker dots — minimal, always visible. Hover for label. -->
  <div class="flex items-center gap-1.5">
    <span class="text-muted-foreground/60">infra</span>
    <span
      class="h-1.5 w-1.5 rounded-full {breakerDot(breakersSnapshot?.db.state)}"
      title="DB · {breakersSnapshot?.db.state ?? '?'}"
    ></span>
    <span
      class="h-1.5 w-1.5 rounded-full {breakerDot(breakersSnapshot?.llm.state)}"
      title="LLM · {breakersSnapshot?.llm.state ?? '?'}"
    ></span>
    <span
      class="h-1.5 w-1.5 rounded-full {breakerDot(breakersSnapshot?.tools.state)}"
      title="Tools · {breakersSnapshot?.tools.state ?? '?'}"
    ></span>
  </div>

  <span class="text-muted-foreground/30">·</span>

  <!-- Hotkey legend — VS Code parity -->
  <div class="hidden items-center gap-2 text-muted-foreground/60 md:flex">
    <kbd class="rounded border border-border bg-muted/40 px-1 font-mono">⌘↵</kbd>
    <span>run</span>
    <kbd class="rounded border border-border bg-muted/40 px-1 font-mono">⌘S</kbd>
    <span>save</span>
  </div>
</div>
