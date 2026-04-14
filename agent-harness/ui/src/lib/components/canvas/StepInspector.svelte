<script lang="ts">
  import type { TestRunStore, StepId } from "$lib/stores/test-run.svelte";
  import type { CanvasStore } from "$lib/stores/canvas.svelte";
  import {
    renderStreamingMarkdown,
    wrapCodeBlocksWithHeader,
  } from "$lib/markdown";

  interface Props {
    runStore: TestRunStore;
    canvasStore: CanvasStore;
  }

  let { runStore, canvasStore }: Props = $props();

  // Markdown rendering for the LLM/Result output bodies. Re-renders
  // reactively as tokens stream in. wrapCodeBlocksWithHeader injects
  // the language label + copy button into <pre><code> blocks.
  let renderedOutputHtml = $state<string>("");

  $effect(() => {
    const text = runStore.tokenBuffer;
    if (!text) {
      renderedOutputHtml = "";
      return;
    }
    renderStreamingMarkdown(text).then((html) => {
      renderedOutputHtml = wrapCodeBlocksWithHeader(html);
    });
  });

  // Click handler for the copy buttons inside rendered code blocks.
  // Mirrors the pattern in ChatMessage.svelte — event delegation so we
  // don't have to attach listeners to dynamically-injected DOM.
  function handleOutputClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const btn = target.closest(".copy-code-btn") as HTMLButtonElement | null;
    if (!btn) return;
    const wrapper = btn.closest(".code-block-wrapper");
    const pre = wrapper?.querySelector("pre");
    if (!pre) return;
    navigator.clipboard.writeText(pre.textContent ?? "");
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  }

  let step = $derived(
    runStore.inspectorStepId
      ? runStore.steps.find((s) => s.id === runStore.inspectorStepId) ?? null
      : null,
  );

  function fmtDur(ms: number | null): string {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  function fmtCost(usd: number): string {
    if (usd === 0) return "$0.00";
    if (usd < 0.001) return "<$0.001";
    return `$${usd.toFixed(4)}`;
  }

  function statusBadgeClass(status: string): string {
    switch (status) {
      case "pending":
        return "bg-muted text-muted-foreground";
      case "running":
        return "bg-primary/10 text-primary";
      case "done":
        return "bg-emerald-500/10 text-emerald-500";
      case "failed":
        return "bg-destructive/10 text-destructive";
      case "resumed":
        return "bg-amber-500/10 text-amber-500";
      default:
        return "bg-muted text-muted-foreground";
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }
</script>

{#if step}
  <div
    class="flex flex-col rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur-sm"
    style="width: 420px; max-height: calc(100vh - 12rem);"
  >
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-border px-4 py-2.5">
      <div class="flex min-w-0 items-center gap-2">
        <span class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Turn {runStore.totals.turns || 1}
        </span>
        <span class="text-muted-foreground/40">/</span>
        <span class="text-xs font-semibold text-foreground">{step.label}</span>
      </div>
      <button
        type="button"
        class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        onclick={() => runStore.closeInspector()}
        aria-label="Close inspector"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <!-- Step navigation -->
    <div class="flex items-center justify-between border-b border-border px-4 py-1.5 text-[10px] text-muted-foreground">
      <button
        type="button"
        class="flex items-center gap-1 hover:text-foreground disabled:opacity-30"
        disabled={runStore.steps.findIndex((s) => s.id === step.id) === 0}
        onclick={() => runStore.stepInInspector(-1)}
      >
        ◀ prev
      </button>
      <span class="font-mono">
        {runStore.sessionId ? runStore.sessionId.slice(0, 8) : "no session"}
      </span>
      <button
        type="button"
        class="flex items-center gap-1 hover:text-foreground disabled:opacity-30"
        disabled={runStore.steps.findIndex((s) => s.id === step.id) === runStore.steps.length - 1}
        onclick={() => runStore.stepInInspector(1)}
      >
        next ▶
      </button>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-y-auto p-4 space-y-4">
      {#if step.id === "setup"}
        <!-- SETUP BODY -->
        <section class="space-y-2">
          <h4 class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Config</h4>
          <dl class="space-y-1 font-mono text-[11px]">
            <div class="flex justify-between">
              <dt class="text-muted-foreground">plan</dt>
              <dd class="text-foreground">{canvasStore.plan}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">model</dt>
              <dd class="text-foreground">{canvasStore.modelOverride || "route → plan default"}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">temperature</dt>
              <dd class="text-foreground">{canvasStore.temperature}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">max_tokens</dt>
              <dd class="text-foreground">{canvasStore.maxTokens}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">max_turns</dt>
              <dd class="text-foreground">{canvasStore.maxTurns}</dd>
            </div>
          </dl>
        </section>

        <section class="space-y-2">
          <h4 class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">System prompt</h4>
          <div class="rounded-md bg-muted/50 p-2 font-mono text-[10px] text-muted-foreground max-h-32 overflow-y-auto whitespace-pre-wrap">
            {canvasStore.systemPrompt.slice(0, 400)}{canvasStore.systemPrompt.length > 400 ? "…" : ""}
          </div>
          <p class="text-[10px] text-muted-foreground font-mono">
            ~{Math.round(canvasStore.systemPrompt.length / 4)} tokens
          </p>
        </section>

        <section class="space-y-2">
          <h4 class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Tools available</h4>
          <p class="text-[11px] text-foreground">{canvasStore.tools.length} tools</p>
        </section>

        <section class="space-y-2">
          <h4 class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Multi-tenant isolation</h4>
          <div class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5 text-[10px] text-emerald-500">
            ✓ RLS enforced via SET LOCAL app.current_org_id
          </div>
        </section>

      {:else if step.id === "governance"}
        <!-- GOVERNANCE BODY -->
        <section class="space-y-2">
          <h4 class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Guards evaluated</h4>
          <div class="space-y-1 text-[11px]">
            {#each [
              { label: "budget-check", detail: canvasStore.budgetEnabled ? `$${canvasStore.budgetLimit} cap` : "off" },
              { label: "rate-limit", detail: "per-session" },
              { label: "circuit-breaker", detail: "db closed · llm closed" },
              { label: "tool-allowlist", detail: `${canvasStore.tools.length} allowed` },
              { label: "org-isolation", detail: "RLS" },
              { label: "timeout", detail: `${Math.round(canvasStore.timeoutSeconds / 60)}m` },
              { label: "pii-redact", detail: "0 matches" },
              { label: "ssrf-block", detail: "n/a" },
            ] as g}
              <div class="flex items-center justify-between rounded bg-muted/30 px-2 py-1">
                <div class="flex items-center gap-1.5">
                  <span class="text-emerald-500">✓</span>
                  <span class="font-mono text-foreground">{g.label}</span>
                </div>
                <span class="text-[10px] text-muted-foreground">{g.detail}</span>
              </div>
            {/each}
          </div>
        </section>

      {:else if step.id === "llm"}
        <!-- LLM BODY — the most-looked-at step -->
        <section class="space-y-2">
          <dl class="space-y-1 font-mono text-[11px]">
            <div class="flex justify-between">
              <dt class="text-muted-foreground">model</dt>
              <dd class="text-foreground">{runStore.modelUsed ?? "—"}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">duration</dt>
              <dd class="text-foreground">{fmtDur(step.durationMs)}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">tokens in</dt>
              <dd class="text-foreground">{runStore.totals.tokensIn}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">tokens out</dt>
              <dd class="text-foreground">{runStore.totals.tokensOut}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">cost</dt>
              <dd class="text-foreground">{fmtCost(runStore.totals.costUsd)}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">gateway</dt>
              <dd class="text-foreground">cf-aig · 300s ttl</dd>
            </div>
          </dl>
        </section>

        <section class="space-y-2">
          <h4 class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Streamed output</h4>
          {#if runStore.tokenBuffer}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="prose-chat rounded-md bg-muted/50 p-3 text-[12px] text-foreground max-h-72 overflow-y-auto"
              onclick={handleOutputClick}
            >
              {@html renderedOutputHtml}
            </div>
          {:else}
            <div class="rounded-md bg-muted/50 p-2 text-[11px] italic text-muted-foreground">
              (no output yet)
            </div>
          {/if}
        </section>

      {:else if step.id === "tools"}
        <!-- TOOLS BODY -->
        <section class="space-y-2">
          <div class="flex items-center justify-between text-[11px]">
            <span class="text-muted-foreground">
              {runStore.toolCalls.length} call{runStore.toolCalls.length === 1 ? "" : "s"}
            </span>
            <span class="text-muted-foreground font-mono">
              {fmtDur(step.durationMs)}
            </span>
          </div>
        </section>

        {#if runStore.toolCalls.length === 0}
          <p class="text-[11px] text-muted-foreground italic">No tool calls in this turn.</p>
        {:else}
          <div class="space-y-2">
            {#each runStore.toolCalls as tc (tc.id)}
              <details class="group rounded-md border border-border bg-muted/20">
                <summary class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[11px]">
                  <span
                    class="font-mono"
                    class:text-emerald-500={tc.status === "done"}
                    class:text-primary={tc.status === "running"}
                    class:text-destructive={tc.status === "failed"}
                  >
                    {tc.status === "done" ? "✓" : tc.status === "failed" ? "✗" : "◐"}
                  </span>
                  <span class="font-mono text-foreground">{tc.name}</span>
                  <span class="ml-auto text-[10px] text-muted-foreground">
                    {tc.latencyMs != null ? fmtDur(tc.latencyMs) : "…"}
                  </span>
                </summary>
                <div class="border-t border-border px-2.5 py-2 space-y-2">
                  <div>
                    <p class="text-[9px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">
                      args
                    </p>
                    <pre class="rounded bg-background p-1.5 text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap">{tc.argsPreview || "(empty)"}</pre>
                  </div>
                  {#if tc.result}
                    <div>
                      <p class="text-[9px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">
                        result
                      </p>
                      <pre class="rounded bg-background p-1.5 text-[10px] text-foreground overflow-x-auto whitespace-pre-wrap max-h-32">{tc.result}</pre>
                    </div>
                  {/if}
                </div>
              </details>
            {/each}
          </div>
        {/if}

      {:else if step.id === "result"}
        <!-- RESULT BODY -->
        <section class="space-y-2">
          <h4 class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Final output</h4>
          {#if runStore.tokenBuffer}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="prose-chat rounded-md bg-muted/50 p-3 text-[12px] text-foreground max-h-80 overflow-y-auto"
              onclick={handleOutputClick}
            >
              {@html renderedOutputHtml}
            </div>
          {:else}
            <div class="rounded-md bg-muted/50 p-2 text-[11px] italic text-muted-foreground">
              (no output)
            </div>
          {/if}
        </section>

        <section class="space-y-2">
          <dl class="space-y-1 font-mono text-[11px]">
            <div class="flex justify-between">
              <dt class="text-muted-foreground">turns</dt>
              <dd class="text-foreground">{runStore.totals.turns}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">tool calls</dt>
              <dd class="text-foreground">{runStore.totals.toolCalls}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">total cost</dt>
              <dd class="text-foreground">{fmtCost(runStore.totals.costUsd)}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">duration</dt>
              <dd class="text-foreground">{fmtDur(runStore.totals.durationMs || null)}</dd>
            </div>
          </dl>
        </section>

      {:else if step.id === "record"}
        <!-- RECORD BODY — the durability flex -->
        <section class="space-y-2">
          <h4 class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Written to</h4>
          <div class="space-y-1 text-[11px]">
            {#each [
              { label: "sessions", detail: runStore.sessionId ? runStore.sessionId.slice(0, 8) : "—" },
              { label: "turns", detail: `${runStore.totals.turns} row${runStore.totals.turns === 1 ? "" : "s"}` },
              { label: "events", detail: `${runStore.events.length} queued` },
              { label: "billing_records", detail: fmtCost(runStore.totals.costUsd) },
              { label: "telemetry queue", detail: "batched" },
            ] as w}
              <div class="flex items-center justify-between rounded bg-muted/30 px-2 py-1">
                <div class="flex items-center gap-1.5">
                  <span class="text-emerald-500">✓</span>
                  <span class="font-mono text-foreground">{w.label}</span>
                </div>
                <span class="text-[10px] text-muted-foreground font-mono">{w.detail}</span>
              </div>
            {/each}
          </div>
        </section>

        {#if runStore.sessionId}
          <section class="space-y-2">
            <h4 class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Checkpoint</h4>
            <button
              type="button"
              class="flex w-full items-center justify-between rounded-md border border-border bg-muted/30 px-2 py-1.5 hover:bg-muted/50"
              onclick={() => copy(`wf_${runStore.sessionId}`)}
            >
              <span class="font-mono text-[10px] text-muted-foreground">
                wf_{runStore.sessionId.slice(0, 12)}…
              </span>
              <span class="text-[9px] text-muted-foreground">click to copy</span>
            </button>
          </section>

          <div class="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2 text-[10px] text-emerald-600 dark:text-emerald-400">
            If this Worker dies now, the next turn resumes from this checkpoint.
          </div>
        {/if}
      {/if}
    </div>

    <!-- Footer -->
    <div class="flex items-center justify-between border-t border-border px-4 py-2 text-[10px]">
      <div class="flex items-center gap-3">
        <span class="text-muted-foreground">duration</span>
        <span class="font-mono text-foreground">{fmtDur(step.durationMs)}</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="text-muted-foreground">status</span>
        <span class="rounded px-1.5 py-0.5 font-mono {statusBadgeClass(step.status)}">
          {step.status}
        </span>
      </div>
    </div>
  </div>
{/if}
