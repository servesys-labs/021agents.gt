<script lang="ts">
  import type { TestRunStore } from "$lib/stores/test-run.svelte";
  import type { CanvasStore } from "$lib/stores/canvas.svelte";
  import { onMount } from "svelte";

  interface Props {
    runStore: TestRunStore;
    canvasStore: CanvasStore;
  }

  let { runStore, canvasStore }: Props = $props();

  let sessionMenuOpen = $state(false);
  let pasteSessionInput = $state("");
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  onMount(() => {
    if (canvasStore.agentName) {
      runStore.loadRecentSessions(canvasStore.agentName);
    }
  });

  $effect(() => {
    if (runStore.composing && textareaEl) {
      // Focus when composer opens
      setTimeout(() => textareaEl?.focus(), 0);
    }
  });

  function onPrimaryClick() {
    if (runStore.status === "running") {
      runStore.stop();
      return;
    }
    if (runStore.composing) {
      runStore.closeComposer();
      return;
    }
    runStore.openComposer();
  }

  function onSubmitRun() {
    const msg = runStore.draftMessage.trim();
    if (!msg) return;
    runStore.start(canvasStore.agentName, msg, canvasStore.plan);
  }

  function onComposerKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onSubmitRun();
    } else if (e.key === "Escape") {
      e.preventDefault();
      runStore.closeComposer();
    }
  }

  function selectSession(id: string | null) {
    runStore.selectedSessionIdForRun = id;
    sessionMenuOpen = false;
  }

  function pasteSessionId() {
    const id = pasteSessionInput.trim();
    if (id) {
      runStore.selectedSessionIdForRun = id;
      pasteSessionInput = "";
      sessionMenuOpen = false;
    }
  }

  function fmtRelative(ts: number): string {
    const diff = Date.now() - ts * 1000;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
  }

  let primaryLabel = $derived(
    runStore.status === "running"
      ? "Stop"
      : runStore.composing
        ? "Cancel"
        : "Test run",
  );

  let primaryClass = $derived(
    runStore.status === "running"
      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
      : "bg-primary text-primary-foreground hover:bg-primary/90",
  );

  let selectedLabel = $derived(
    runStore.selectedSessionIdForRun
      ? runStore.selectedSessionIdForRun.slice(0, 6)
      : "new",
  );
</script>

<div class="flex items-center gap-1.5">
  <!-- Primary button — accent shadow makes it visually dominate the toolbar -->
  <button
    type="button"
    class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all {primaryClass}"
    style={runStore.status !== "running"
      ? "box-shadow: 0 4px 14px -4px hsl(var(--primary) / 0.5);"
      : ""}
    onclick={onPrimaryClick}
  >
    {#if runStore.status === "running"}
      <span class="h-2 w-2 rounded-sm bg-current"></span>
    {:else}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-3 w-3"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M8 5v14l11-7z" />
      </svg>
    {/if}
    {primaryLabel}
    {#if runStore.status !== "running" && !runStore.composing}
      <kbd class="ml-0.5 hidden rounded border border-primary-foreground/20 bg-primary-foreground/10 px-1 text-[9px] font-mono text-primary-foreground/70 sm:inline">
        ⌘↵
      </kbd>
    {/if}
  </button>

  <!-- Session selector -->
  <div class="relative">
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      onclick={() => (sessionMenuOpen = !sessionMenuOpen)}
    >
      <span class="font-mono">session: {selectedLabel}</span>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-3 w-3"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        stroke-width="2"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    {#if sessionMenuOpen}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="fixed inset-0 z-40"
        onclick={() => (sessionMenuOpen = false)}
      ></div>
      <div class="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-border bg-card shadow-lg">
        <div class="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Session
        </div>
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
          onclick={() => selectSession(null)}
        >
          <span
            class="h-1.5 w-1.5 rounded-full"
            class:bg-primary={runStore.selectedSessionIdForRun === null}
            class:bg-muted-foreground={runStore.selectedSessionIdForRun !== null}
          ></span>
          <span class="font-mono">new</span>
          <span class="ml-auto text-[10px] text-muted-foreground">fresh session</span>
        </button>

        {#if runStore.recentSessions.length > 0}
          <div class="mt-1 border-t border-border px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Recent
          </div>
          <div class="max-h-48 overflow-y-auto">
            {#each runStore.recentSessions as s (s.session_id)}
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                onclick={() => selectSession(s.session_id)}
              >
                <span class="font-mono text-[11px]">{s.session_id.slice(0, 8)}</span>
                <span class="ml-auto text-[10px] text-muted-foreground">
                  {fmtRelative(s.created_at)}
                </span>
              </button>
            {/each}
          </div>
        {/if}

        <div class="border-t border-border px-3 py-2">
          <div class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
            Paste session ID
          </div>
          <div class="flex gap-1">
            <input
              type="text"
              placeholder="a3f2…"
              class="flex-1 rounded border border-border bg-background px-2 py-1 text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              bind:value={pasteSessionInput}
              onkeydown={(e) => e.key === "Enter" && pasteSessionId()}
            />
            <button
              type="button"
              class="rounded border border-border bg-card px-2 py-1 text-[11px] hover:bg-accent"
              onclick={pasteSessionId}
            >
              use
            </button>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<!-- Composing drawer — slides down from under the top toolbar.
     Positioned absolute relative to the canvas wrapper so the canvas + the
     pipeline overlay above it stay fully visible while the user is typing
     a test message. -->
{#if runStore.composing}
  <div
    class="pointer-events-auto absolute left-1/2 top-12 z-50 w-[min(720px,calc(100vw-2rem))] -translate-x-1/2 translate-y-2 rounded-lg border border-border bg-card/98 shadow-2xl backdrop-blur composing-slide-down"
  >
    <div class="flex items-center justify-between border-b border-border px-4 py-2">
      <div class="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span class="font-mono uppercase tracking-wider">Test run</span>
        <span>·</span>
        <span>
          Budget {canvasStore.budgetEnabled ? `$${canvasStore.budgetLimit}` : "off"}
        </span>
        <span>·</span>
        <span>Plan {canvasStore.plan}</span>
        <span>·</span>
        <span class="font-mono">session: {selectedLabel}</span>
      </div>
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground text-[10px]"
        onclick={() => runStore.closeComposer()}
      >
        esc
      </button>
    </div>
    <textarea
      bind:this={textareaEl}
      bind:value={runStore.draftMessage}
      onkeydown={onComposerKeydown}
      placeholder="Send a test message to this agent…"
      rows="3"
      class="w-full resize-none bg-transparent px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
    ></textarea>
    <div class="flex items-center justify-between border-t border-border px-4 py-2">
      <span class="text-[10px] text-muted-foreground font-mono">
        ⌘↵ to run · esc to cancel
      </span>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        disabled={!runStore.draftMessage.trim()}
        onclick={onSubmitRun}
      >
        Run
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      </button>
    </div>
  </div>
{/if}

<style>
  .composing-slide-down {
    animation: slide-down 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes slide-down {
    from {
      opacity: 0;
      transform: translate(-50%, -8px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0.5rem);
    }
  }
</style>
