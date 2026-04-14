<script lang="ts">
  import { page } from "$app/state";
  import { toast } from "svelte-sonner";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import AgentNav from "$lib/components/agent/AgentNav.svelte";
  import { api } from "$lib/services/api";
  import { renderMarkdown } from "$lib/markdown";
  import { timeAgo } from "$lib/utils/time";

  const agentName = $derived(page.params.name ?? "");

  interface ScheduledRun {
    session_id: string;
    status: string;
    input_text: string;
    output_text: string;
    step_count: number;
    wall_clock_seconds: number;
    cost_total_usd: number;
    model: string;
    created_at: string;
    ended_at: string | null;
  }

  let runs = $state<ScheduledRun[]>([]);
  let loading = $state(true);
  let expandedId = $state<string | null>(null);
  let renderedOutputs = $state(new Map<string, string>());

  function asString(value: unknown): string {
    if (typeof value === "string") return value;
    if (value == null) return "";
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function normalizeRun(input: unknown): ScheduledRun {
    const raw = (input ?? {}) as Record<string, unknown>;
    return {
      session_id: asString(raw.session_id),
      status: asString(raw.status),
      input_text: asString(raw.input_text),
      output_text: asString(raw.output_text),
      step_count: typeof raw.step_count === "number" ? raw.step_count : Number(raw.step_count ?? 0),
      wall_clock_seconds: typeof raw.wall_clock_seconds === "number" ? raw.wall_clock_seconds : Number(raw.wall_clock_seconds ?? 0),
      cost_total_usd: typeof raw.cost_total_usd === "number" ? raw.cost_total_usd : Number(raw.cost_total_usd ?? 0),
      model: asString(raw.model),
      created_at: asString(raw.created_at),
      ended_at: raw.ended_at == null ? null : asString(raw.ended_at),
    };
  }

  async function load() {
    loading = true;
    try {
      // Fetch sessions that came from scheduled runs (channel = 'schedule' or 'cron' or input matches schedule pattern)
      const data = await api.get<ScheduledRun[] | { sessions: ScheduledRun[] }>(
        `/sessions?agent_name=${encodeURIComponent(agentName)}&limit=20&channel=api`
      );
      const sessionsRaw = Array.isArray(data) ? data : (data.sessions ?? []);
      const sessions = sessionsRaw.map(normalizeRun);
      // Filter to likely scheduled runs (input contains schedule-like content or channel is schedule)
      runs = sessions.filter((s: ScheduledRun) =>
        s.input_text.length > 50 && !s.input_text.startsWith("hi") && !s.input_text.startsWith("Hello")
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load runs");
    } finally {
      loading = false;
    }
  }

  async function toggleExpand(sessionId: string) {
    if (expandedId === sessionId) {
      expandedId = null;
      return;
    }
    expandedId = sessionId;

    // Render markdown for the output if not cached
    if (!renderedOutputs.has(sessionId)) {
      const run = runs.find(r => r.session_id === sessionId);
      if (run?.output_text) {
        const html = await renderMarkdown(run.output_text);
        renderedOutputs.set(sessionId, html);
        renderedOutputs = new Map(renderedOutputs);
      }
    }
  }

  function statusBadge(status: string): "standard" | "destructive" | "secondary" | "free" {
    if (status === "success") return "free";
    if (status === "error" || status === "failed") return "destructive";
    return "secondary";
  }

  function formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }

  $effect(() => {
    if (agentName) load();
  });
</script>

<AgentNav {agentName} />

<div class="w-full px-6 py-8 lg:px-8">
  <div class="mb-8">
    <h1>Scheduled Runs</h1>
    <p class="mt-1.5 text-sm text-muted-foreground">
      History of autonomous agent runs — digests, scheduled tasks, and background jobs.
    </p>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-24">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
    </div>
  {:else if runs.length === 0}
    <div class="rounded-lg border border-dashed border-border py-16 text-center">
      <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-12 w-12 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <h3 class="mt-4 text-foreground">No scheduled runs yet</h3>
      <p class="mt-1.5 text-sm text-muted-foreground">
        Use <code class="rounded bg-muted px-1 py-0.5 text-xs">create-schedule</code> in chat to set up recurring tasks.
      </p>
    </div>
  {:else}
    <div class="space-y-3">
      {#each runs as run}
        <div class="rounded-xl border border-border bg-card overflow-hidden transition-all">
          <!-- Run header — click to expand -->
          <button
            class="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-muted/30 transition-colors"
            onclick={() => toggleExpand(run.session_id)}
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <Badge variant={statusBadge(run.status)}>{run.status}</Badge>
                <span class="text-xs text-muted-foreground">{timeAgo(run.created_at)}</span>
                {#if run.wall_clock_seconds > 0}
                  <span class="text-xs text-muted-foreground">({formatDuration(run.wall_clock_seconds)})</span>
                {/if}
              </div>
              <p class="text-sm text-foreground truncate">{run.input_text.slice(0, 120)}</p>
            </div>
            <div class="flex items-center gap-3 shrink-0 text-xs text-muted-foreground">
              {#if run.step_count > 0}
                <span>{run.step_count} steps</span>
              {/if}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 transition-transform {expandedId === run.session_id ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </button>

          <!-- Expanded output -->
          {#if expandedId === run.session_id}
            <div class="border-t border-border px-5 py-4 bg-muted/10">
              {#if run.output_text}
                {#if renderedOutputs.has(run.session_id)}
                  <div class="prose-chat text-sm max-w-none">
                    {@html renderedOutputs.get(run.session_id) ?? ""}
                  </div>
                {:else}
                  <div class="whitespace-pre-wrap text-sm text-foreground">{run.output_text}</div>
                {/if}
              {:else if run.status === "error" || run.status === "failed"}
                <p class="text-sm text-destructive">Run failed — no output generated.</p>
              {:else}
                <p class="text-sm text-muted-foreground">No output text recorded for this run.</p>
              {/if}

              <!-- Run metadata -->
              <div class="mt-4 flex flex-wrap gap-4 text-xs text-muted-foreground border-t border-border pt-3">
                <span>Session: <code class="rounded bg-muted px-1 py-0.5">{run.session_id}</code></span>
                {#if run.model}
                  <span>Model: {run.model}</span>
                {/if}
                {#if run.cost_total_usd > 0}
                  <span>Cost: ${Number(run.cost_total_usd || 0).toFixed(4)}</span>
                {/if}
                <span>{new Date(run.created_at).toLocaleString()}</span>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
