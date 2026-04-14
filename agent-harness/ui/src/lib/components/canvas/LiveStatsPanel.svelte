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

  let breakersSnapshot = $state<BreakersSnapshot | null>(null);
  let breakersError = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  // Whole-panel collapse state, persisted across reloads. The collapsed
  // version is a single chip showing spend + the three breaker dots so
  // users still get health-at-a-glance without the full panel.
  let collapsed = $state(false);
  const COLLAPSE_KEY = "oneshots_canvas_stats_collapsed";

  $effect(() => {
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem(COLLAPSE_KEY) === "1") collapsed = true;
  });

  function togglePanel() {
    collapsed = !collapsed;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    }
  }

  // Polling strategy:
  //   running:     2s  — breakers can move fast during a run, want responsiveness
  //   idle:        10s — soft health signal, no point hammering
  //   backgrounded: paused entirely — no point polling a tab nobody's looking at
  //
  // Svelte 5 effect reruns whenever runStore.status or document visibility
  // changes, so the timer always matches the current mode without manual
  // teardown/restart calls scattered through the code.
  const POLL_MS_RUNNING = 2_000;
  const POLL_MS_IDLE = 10_000;

  async function refreshBreakers() {
    if (inFlight) return; // coalesce in case of overlap
    inFlight = true;
    try {
      breakersSnapshot = await fetchBreakers();
      breakersError = null;
    } catch (err) {
      breakersError = err instanceof Error ? err.message : "fetch failed";
    } finally {
      inFlight = false;
    }
  }

  function clearTimer() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // Track backgrounded state reactively so the poll effect can depend on it.
  let backgrounded = $state(
    typeof document !== "undefined" && document.visibilityState === "hidden",
  );

  function handleVisibilityChange() {
    const hidden = document.visibilityState === "hidden";
    backgrounded = hidden;
    // Tab just came back into focus — refresh immediately so the user sees
    // a fresh snapshot instead of a stale one from when they left.
    if (!hidden) refreshBreakers();
  }

  onMount(() => {
    refreshBreakers();
    document.addEventListener("visibilitychange", handleVisibilityChange);
  });

  onDestroy(() => {
    clearTimer();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  });

  // Reactive poll controller: one $effect handles all three modes.
  // Runs whenever runStore.status or backgrounded changes.
  $effect(() => {
    clearTimer();
    if (backgrounded) return; // paused

    const intervalMs =
      runStore.status === "running" ? POLL_MS_RUNNING : POLL_MS_IDLE;
    pollTimer = setInterval(refreshBreakers, intervalMs);
  });

  // Refresh immediately when a run completes/fails — breakers may have moved.
  $effect(() => {
    if (runStore.status === "complete" || runStore.status === "failed") {
      refreshBreakers();
    }
  });

  // Aggregates from recent sessions
  let recentSpend = $derived(
    runStore.recentSessions.reduce((sum, s) => sum + (s.cost_total_usd || 0), 0),
  );
  let recentCount = $derived(runStore.recentSessions.length);
  let avgLatency = $derived(
    recentCount > 0
      ? runStore.recentSessions.reduce(
          (sum, s) => sum + (s.wall_clock_seconds || 0),
          0,
        ) / recentCount
      : 0,
  );

  // Live spend from current run
  let liveSpend = $derived(runStore.totals.costUsd);
  let budgetLimit = $derived(
    canvasStore.budgetEnabled ? canvasStore.budgetLimit : 0,
  );
  let budgetPct = $derived(
    budgetLimit > 0 ? Math.min(100, (liveSpend / budgetLimit) * 100) : 0,
  );
  let budgetColor = $derived(
    budgetPct > 80
      ? "bg-destructive"
      : budgetPct > 50
        ? "bg-amber-500"
        : "bg-emerald-500",
  );

  function fmtCost(usd: number): string {
    if (usd === 0) return "$0.00";
    if (usd < 0.001) return "<$0.001";
    return `$${usd.toFixed(3)}`;
  }

  function fmtSec(s: number): string {
    if (s < 1) return `${Math.round(s * 1000)}ms`;
    if (s < 60) return `${s.toFixed(1)}s`;
    return `${Math.round(s / 60)}m`;
  }

  interface BreakerRow {
    key: "db" | "llm" | "tools";
    label: string;
    state: BreakerState;
    detail?: string;
    /** Structured drilldown shown when the row is expanded. */
    drilldown?: Array<{
      name: string;
      state?: string;
      detail?: string;
    }>;
    /** Whether this row is clickable to expand. */
    expandable: boolean;
  }

  let breakers = $derived<BreakerRow[]>([
    {
      key: "db",
      label: "db",
      state: breakersSnapshot?.db.state ?? "closed",
      detail:
        breakersSnapshot && breakersSnapshot.db.failures > 0
          ? `${breakersSnapshot.db.failures} fails`
          : undefined,
      drilldown:
        breakersSnapshot && breakersSnapshot.db.opened_at
          ? [
              {
                name: "opened",
                detail: new Date(breakersSnapshot.db.opened_at).toLocaleTimeString(),
              },
              {
                name: "failures",
                detail: String(breakersSnapshot.db.failures),
              },
            ]
          : undefined,
      expandable: !!(breakersSnapshot && breakersSnapshot.db.failures > 0),
    },
    {
      key: "llm",
      label: "llm",
      state: breakersSnapshot?.llm.state ?? "closed",
      detail:
        breakersSnapshot && (breakersSnapshot.llm.failures ?? 0) > 0
          ? `${breakersSnapshot.llm.failures} fails`
          : undefined,
      drilldown:
        breakersSnapshot && breakersSnapshot.llm.last_error
          ? [
              {
                name: "last error",
                detail: breakersSnapshot.llm.last_error,
              },
              ...(breakersSnapshot.llm.last_failure_at
                ? [
                    {
                      name: "at",
                      detail: new Date(
                        breakersSnapshot.llm.last_failure_at,
                      ).toLocaleTimeString(),
                    },
                  ]
                : []),
            ]
          : undefined,
      expandable: !!(breakersSnapshot && breakersSnapshot.llm.last_error),
    },
    {
      key: "tools",
      label: "tools",
      state: breakersSnapshot?.tools.state ?? "closed",
      detail: breakersSnapshot
        ? breakersSnapshot.tools.open_count > 0
          ? `${breakersSnapshot.tools.open_count} open`
          : breakersSnapshot.tools.half_open_count > 0
            ? `${breakersSnapshot.tools.half_open_count} half`
            : undefined
        : undefined,
      drilldown: breakersSnapshot?.tools.worst_tools?.length
        ? breakersSnapshot.tools.worst_tools.map((t) => ({
            name: t.name,
            state: t.state,
            detail: `${t.failures} fail${t.failures === 1 ? "" : "s"}`,
          }))
        : undefined,
      expandable: !!(
        breakersSnapshot?.tools.worst_tools?.length &&
        breakersSnapshot.tools.worst_tools.length > 0
      ),
    },
  ]);

  // True when all three breakers are closed AND there's no degraded flag.
  // Used to compress the breaker section to a single "all systems healthy"
  // row instead of three identical green dots.
  let allHealthy = $derived(
    !!breakersSnapshot &&
      !breakersSnapshot.degraded &&
      breakersSnapshot.db.state === "closed" &&
      breakersSnapshot.llm.state === "closed" &&
      breakersSnapshot.tools.state === "closed",
  );

  // True when no run has happened yet AND no historical sessions exist.
  // Lets the panel show an intentional "first run will fill this in" copy
  // instead of a wall of zeros that looks broken.
  let isFirstUse = $derived(
    runStore.status === "idle" &&
      runStore.totals.turns === 0 &&
      runStore.recentSessions.length === 0,
  );

  let expandedRows = $state<Set<string>>(new Set());

  function toggleRow(key: string) {
    const next = new Set(expandedRows);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedRows = next;
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

  function drilldownDot(state: string | undefined): string {
    if (state === "open") return "bg-destructive";
    if (state === "half-open") return "bg-amber-500";
    if (state === "closed") return "bg-emerald-500";
    return "bg-muted-foreground/40";
  }
</script>

{#if collapsed}
  <!-- Collapsed chip — keeps health-at-a-glance visible without the
       full panel. Click anywhere on the chip to expand. -->
  <button
    type="button"
    class="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-card/95 px-2.5 py-1.5 shadow-lg backdrop-blur-sm transition-colors hover:bg-accent"
    onclick={togglePanel}
    title="Expand live stats"
    aria-label="Expand live stats panel"
  >
    <span class="text-[10px] font-mono text-muted-foreground">{fmtCost(liveSpend)}</span>
    <span class="text-muted-foreground/40">·</span>
    <span class="flex items-center gap-1">
      <span
        class="h-1.5 w-1.5 rounded-full {breakerDot(breakersSnapshot?.db.state)}"
        title="DB"
      ></span>
      <span
        class="h-1.5 w-1.5 rounded-full {breakerDot(breakersSnapshot?.llm.state)}"
        title="LLM"
      ></span>
      <span
        class="h-1.5 w-1.5 rounded-full {breakerDot(breakersSnapshot?.tools.state)}"
        title="Tools"
      ></span>
    </span>
    <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
    </svg>
  </button>
{:else}
<div
  class="pointer-events-auto rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur-sm"
  style="width: 260px;"
>
  <div class="flex items-center justify-between border-b border-border px-3 py-2">
    <p class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      Live stats
    </p>
    <button
      type="button"
      class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      onclick={togglePanel}
      title="Collapse"
      aria-label="Collapse live stats panel"
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  </div>

  <div class="space-y-3 p-3">
    {#if isFirstUse}
      <!-- First-use state — replaces the zeros wall with intentional copy -->
      <div class="flex flex-col items-center gap-2 py-2 text-center">
        <div class="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-5 w-5 text-primary"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
          </svg>
        </div>
        <p class="text-[11px] font-medium text-foreground">No runs yet</p>
        <p class="text-[10px] text-muted-foreground leading-snug">
          Spend, tokens, and breaker health<br />stream in during your first run.
        </p>
      </div>
      <!-- Circuit breakers still shown so users can see infra health pre-run -->
    {:else}
    <!-- Spend gauge -->
    <div>
      <div class="mb-1 flex items-center justify-between text-[10px]">
        <span class="text-muted-foreground">spend · this run</span>
        <span class="font-mono text-foreground">{fmtCost(liveSpend)}</span>
      </div>
      {#if budgetLimit > 0}
        <div class="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            class="h-full transition-all duration-300 {budgetColor}"
            style="width: {budgetPct}%"
          ></div>
        </div>
        <div class="mt-0.5 flex justify-between text-[9px] text-muted-foreground font-mono">
          <span>${liveSpend.toFixed(3)}</span>
          <span>${budgetLimit.toFixed(2)} cap</span>
        </div>
      {:else}
        <p class="text-[9px] text-muted-foreground italic">No budget cap set</p>
      {/if}
    </div>

    <!-- Tokens -->
    <div class="grid grid-cols-2 gap-2">
      <div class="rounded bg-muted/30 px-2 py-1.5">
        <p class="text-[9px] text-muted-foreground">tokens in</p>
        <p class="font-mono text-xs text-foreground">
          {runStore.totals.tokensIn}
        </p>
      </div>
      <div class="rounded bg-muted/30 px-2 py-1.5">
        <p class="text-[9px] text-muted-foreground">tokens out</p>
        <p class="font-mono text-xs text-foreground">
          {runStore.totals.tokensOut}
        </p>
      </div>
    </div>

    <!-- Turns + tool calls -->
    <div class="grid grid-cols-2 gap-2">
      <div class="rounded bg-muted/30 px-2 py-1.5">
        <p class="text-[9px] text-muted-foreground">turns</p>
        <p class="font-mono text-xs text-foreground">{runStore.totals.turns}</p>
      </div>
      <div class="rounded bg-muted/30 px-2 py-1.5">
        <p class="text-[9px] text-muted-foreground">tool calls</p>
        <p class="font-mono text-xs text-foreground">
          {runStore.totals.toolCalls}
        </p>
      </div>
    </div>

    <!-- Recent sessions aggregate -->
    <div class="border-t border-border pt-3">
      <p class="mb-1.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        Recent sessions
      </p>
      <div class="space-y-1 text-[10px]">
        <div class="flex justify-between">
          <span class="text-muted-foreground">count</span>
          <span class="font-mono text-foreground">{recentCount}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-muted-foreground">spend · total</span>
          <span class="font-mono text-foreground">{fmtCost(recentSpend)}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-muted-foreground">avg latency</span>
          <span class="font-mono text-foreground">{fmtSec(avgLatency)}</span>
        </div>
      </div>
    </div>
    {/if}

    <!-- Circuit breakers (always shown — even pre-first-run) -->
    <div class="border-t border-border pt-3">
      <div class="mb-1.5 flex items-center justify-between">
        <p class="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
          Circuit breakers
        </p>
        {#if breakersSnapshot?.degraded}
          <span class="text-[9px] text-amber-500" title={breakersError ?? "runtime unreachable"}>
            degraded
          </span>
        {:else if breakersError}
          <span class="text-[9px] text-destructive" title={breakersError}>
            offline
          </span>
        {:else if backgrounded}
          <span class="text-[9px] text-muted-foreground/60" title="Paused — tab backgrounded">
            paused
          </span>
        {:else if runStore.status === "running"}
          <span class="text-[9px] text-primary animate-pulse" title="Fast-poll — run active">
            live
          </span>
        {/if}
      </div>
      {#if allHealthy}
        <!-- Compressed healthy state: single row instead of three identical greens -->
        <div class="flex items-center gap-1.5 rounded bg-muted/30 px-1.5 py-1">
          <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
          <span class="text-[10px] font-mono text-muted-foreground">all systems healthy</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="ml-auto h-2.5 w-2.5 text-emerald-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="3"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
      {:else}
      <div class="space-y-1">
        {#each breakers as b (b.key)}
          {@const expanded = expandedRows.has(b.key)}
          <div class="rounded bg-muted/30">
            <button
              type="button"
              class="flex w-full items-center gap-1.5 px-1.5 py-1 text-left transition-colors {b.expandable ? 'hover:bg-muted/50' : 'cursor-default'}"
              onclick={() => b.expandable && toggleRow(b.key)}
              disabled={!b.expandable}
              aria-expanded={b.expandable ? expanded : undefined}
            >
              <span class="h-1.5 w-1.5 rounded-full {breakerDot(b.state)}"></span>
              <span class="text-[10px] font-mono text-muted-foreground">
                {b.label}
              </span>
              {#if b.detail}
                <span class="ml-auto text-[9px] font-mono text-muted-foreground">
                  {b.detail}
                </span>
              {/if}
              {#if b.expandable}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="h-2.5 w-2.5 shrink-0 text-muted-foreground transition-transform duration-150"
                  class:rotate-180={expanded}
                  class:ml-auto={!b.detail}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  stroke-width="2.5"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              {/if}
            </button>
            {#if expanded && b.drilldown}
              <div class="border-t border-border/50 px-2 pb-1.5 pt-1">
                {#each b.drilldown as d (d.name)}
                  <div class="flex items-center gap-1.5 py-0.5">
                    <span class="h-1 w-1 rounded-full {drilldownDot(d.state)}"></span>
                    <span class="truncate text-[9px] font-mono text-muted-foreground">
                      {d.name}
                    </span>
                    {#if d.detail}
                      <span class="ml-auto truncate text-[9px] font-mono text-foreground/80">
                        {d.detail}
                      </span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
      {/if}
    </div>
  </div>
</div>
{/if}
