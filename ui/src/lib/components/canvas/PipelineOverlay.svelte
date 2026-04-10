<script lang="ts">
  import type { TestRunStore, StepState } from "$lib/stores/test-run.svelte";

  interface Props {
    runStore: TestRunStore;
  }

  let { runStore }: Props = $props();

  let expanded = $state(false);

  // Auto-expand while running
  $effect(() => {
    if (runStore.status === "running") {
      expanded = true;
    }
  });

  function fmtDur(ms: number | null): string {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function fmtCost(usd: number): string {
    if (usd === 0) return "$0.00";
    if (usd < 0.001) return "<$0.001";
    return `$${usd.toFixed(3)}`;
  }

  function statusIcon(status: StepState["status"]): string {
    switch (status) {
      case "pending":
        return "·";
      case "running":
        return "◐";
      case "done":
        return "✓";
      case "failed":
        return "✗";
      case "resumed":
        return "⟲";
    }
  }

  function stepColor(status: StepState["status"]): string {
    switch (status) {
      case "pending":
        return "text-muted-foreground/50";
      case "running":
        return "text-primary animate-pulse";
      case "done":
        return "text-emerald-500";
      case "failed":
        return "text-destructive";
      case "resumed":
        return "text-amber-500";
    }
  }

  function runStatusDot(): string {
    switch (runStore.status) {
      case "running":
        return "bg-primary animate-pulse";
      case "complete":
        return "bg-emerald-500";
      case "failed":
        return "bg-destructive";
      case "resumed":
        return "bg-amber-500";
      default:
        return "bg-muted-foreground/40";
    }
  }

  function runStatusLabel(): string {
    switch (runStore.status) {
      case "idle":
        return "No run yet";
      case "composing":
        return "Composing";
      case "running":
        return `Live · turn ${runStore.totals.turns || 1}`;
      case "complete":
        return "Completed";
      case "failed":
        return `Failed · ${runStore.errorMessage ?? "error"}`;
      case "resumed":
        return "Resumed from checkpoint";
    }
  }

  function summaryLine(): string {
    const t = runStore.totals;
    if (runStore.status === "idle") {
      return "Run this agent to see every step of the edge runtime light up";
    }
    const parts: string[] = [];
    parts.push(`${t.turns || 1} turn${t.turns === 1 ? "" : "s"}`);
    parts.push(`${t.toolCalls} tool${t.toolCalls === 1 ? "" : "s"}`);
    parts.push(`${t.tokensIn + t.tokensOut} tok`);
    parts.push(fmtCost(t.costUsd));
    parts.push(fmtDur(t.durationMs || null));
    return parts.join(" · ");
  }

  // Index of the step that should ghost-pulse during the empty state
  // teaser animation. Steps through 0..5 on a ~600ms interval, looping.
  // Only runs when expanded + idle (no run yet) so it teases the user
  // into clicking Test run.
  let teaserIndex = $state(0);
  let teaserTimer: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    const shouldTease = expanded && runStore.status === "idle";
    if (shouldTease && !teaserTimer) {
      teaserTimer = setInterval(() => {
        teaserIndex = (teaserIndex + 1) % 6;
      }, 600);
    } else if (!shouldTease && teaserTimer) {
      clearInterval(teaserTimer);
      teaserTimer = null;
      teaserIndex = 0;
    }
  });
</script>

<div
  class="pointer-events-auto rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur-sm transition-all duration-200"
  style="width: min(720px, calc(100vw - 2rem));"
>
  <!-- Header row (always visible) -->
  <button
    type="button"
    class="flex w-full items-center gap-3 px-4 py-2.5 text-left"
    onclick={() => (expanded = !expanded)}
  >
    <span class="flex h-2 w-2 shrink-0 rounded-full {runStatusDot()}"></span>
    <span class="text-xs font-medium text-foreground whitespace-nowrap">
      {runStatusLabel()}
    </span>
    <span class="text-xs text-muted-foreground/60">·</span>
    <span class="flex-1 truncate text-xs text-muted-foreground font-mono">
      {summaryLine()}
    </span>
    {#if runStore.sessionId}
      <span class="hidden shrink-0 font-mono text-[10px] text-muted-foreground/60 md:inline">
        {runStore.sessionId.slice(0, 8)}
      </span>
    {/if}
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200"
      class:rotate-180={expanded}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      stroke-width="2"
    >
      <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  </button>

  <!-- Expanded: step pills -->
  {#if expanded}
    <div class="border-t border-border px-4 py-3">
      <div class="flex items-center gap-1.5 overflow-x-auto">
        {#each runStore.steps as step, i (step.id)}
          {@const teasing = runStore.status === "idle" && i === teaserIndex}
          <button
            type="button"
            class="group flex items-center gap-2 rounded-md border border-transparent px-2.5 py-1.5 text-left transition-all duration-300 hover:border-border hover:bg-accent/30"
            class:bg-accent={runStore.inspectorStepId === step.id}
            class:teaser-pulse={teasing}
            style="min-width: 86px;"
            onclick={() => runStore.openInspector(step.id)}
          >
            <span
              class="font-mono text-sm leading-none {stepColor(step.status)}"
            >
              {statusIcon(step.status)}
            </span>
            <div class="flex min-w-0 flex-col">
              <span class="flex items-center gap-1 text-[11px] font-medium leading-tight text-foreground">
                {step.label}
                {#if step.id === "llm" && runStore.modelUsed}
                  <span class="truncate text-[9px] font-normal text-muted-foreground/70 max-w-[80px]" title={runStore.modelUsed}>
                    {runStore.modelUsed.split("/").pop()}
                  </span>
                {/if}
                {#if step.status === "resumed"}
                  <span class="rounded-sm bg-amber-500/15 px-1 text-[8px] font-mono text-amber-500" title="Resumed from checkpoint">
                    ⟲
                  </span>
                {/if}
              </span>
              <span class="text-[10px] leading-tight text-muted-foreground font-mono">
                {#if step.status === "running"}
                  running…
                {:else if step.status === "done" || step.status === "resumed"}
                  {fmtDur(step.durationMs)}
                {:else if step.status === "failed"}
                  failed
                {:else}
                  pending
                {/if}
              </span>
            </div>
          </button>
          {#if i < runStore.steps.length - 1}
            <span class="text-muted-foreground/40">→</span>
          {/if}
        {/each}
      </div>

      <!-- Live detail row -->
      {#if runStore.status === "running" && runStore.currentStepId}
        {@const active = runStore.steps.find((s) => s.id === runStore.currentStepId)}
        {#if active?.detail}
          <div class="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span class="font-mono uppercase">{active.label}</span>
            <span>·</span>
            <span class="truncate">{active.detail}</span>
          </div>
        {/if}
      {/if}

      {#if runStore.resumed}
        <div class="mt-2 flex items-center gap-1.5 text-[9px] text-amber-500/80">
          <span>⟲</span>
          <span>Resumed from a Workflow checkpoint — Worker restarted mid-run.</span>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Empty-state teaser: a soft pulse that travels through each step pill
     in sequence so a first-time visitor sees the pipeline "wake up" and
     understands what will happen on a real run. */
  :global(.teaser-pulse) {
    background: hsl(var(--primary) / 0.12);
    box-shadow: 0 0 12px -2px hsl(var(--primary) / 0.4);
  }
</style>
