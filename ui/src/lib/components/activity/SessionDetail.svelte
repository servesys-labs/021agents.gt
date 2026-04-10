<script lang="ts">
  import Badge from "$lib/components/ui/badge.svelte";
  import ToolCallBlock from "$lib/components/chat/ToolCallBlock.svelte";
  import type { Session, Turn } from "$lib/services/sessions";
  import { formatDuration, formatCost, timeAgo } from "$lib/utils/time";
  import { renderMarkdown } from "$lib/markdown";
  import { api } from "$lib/services/api";

  interface Props {
    session: Session;
    turns: Turn[];
  }

  let { session, turns }: Props = $props();

  // Trace expansion
  let traceOpen = $state(false);
  let traceLoading = $state(false);
  let traceSessions = $state<Session[]>([]);

  async function loadTrace() {
    if (traceLoading || !session.trace_id) return;
    traceOpen = !traceOpen;
    if (!traceOpen) return;
    traceLoading = true;
    try {
      const data = await api.get<any>(`/sessions/${encodeURIComponent(session.session_id)}/trace`);
      traceSessions = Array.isArray(data) ? data : (data.sessions ?? data.trace ?? []);
    } catch {
      traceSessions = [];
    } finally {
      traceLoading = false;
    }
  }

  // Render markdown for each turn content
  let renderedContent = $state<Map<number, string>>(new Map());

  interface ToolCallView {
    name: string;
    input: string;
    output?: string;
    call_id: string;
    latency_ms?: number;
    error?: string;
  }

  function normalizeToolCall(tc: unknown, index: number): ToolCallView {
    const raw = (tc ?? {}) as Record<string, unknown>;
    return {
      name: String(raw.name ?? raw.tool ?? "tool"),
      input:
        typeof raw.input === "string"
          ? raw.input
          : JSON.stringify(raw.input ?? raw.args ?? {}, null, 2),
      output: typeof raw.output === "string" ? raw.output : undefined,
      call_id: String(raw.call_id ?? raw.tool_call_id ?? `tc-${index}`),
      latency_ms: typeof raw.latency_ms === "number" ? raw.latency_ms : undefined,
      error: typeof raw.error === "string" ? raw.error : undefined,
    };
  }

  $effect(() => {
    const renderAll = async () => {
      const map = new Map<number, string>();
      for (const turn of turns) {
        if (turn.content && turn.execution_mode === "llm") {
          map.set(turn.turn_number, await renderMarkdown(turn.content));
        }
      }
      renderedContent = map;
    };
    renderAll();
  });
</script>

<div class="space-y-6">
  <!-- Session metadata bar -->
  <div class="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs">
    <div class="flex items-center gap-1.5">
      <span class="text-muted-foreground">ID:</span>
      <code class="font-mono text-foreground">{session.session_id.slice(0, 12)}</code>
    </div>
    <span class="text-border">|</span>
    <div class="flex items-center gap-1.5">
      <span class="text-muted-foreground">Steps:</span>
      <span class="text-foreground">{session.step_count}</span>
    </div>
    <span class="text-border">|</span>
    <div class="flex items-center gap-1.5">
      <span class="text-muted-foreground">Status:</span>
      <Badge variant={session.status === "error" ? "destructive" : "default"}>
        {session.status}
      </Badge>
    </div>
    <span class="text-border">|</span>
    <div class="flex items-center gap-1.5">
      <span class="text-muted-foreground">Cost:</span>
      <span class="text-foreground">{formatCost(session.cost_total_usd)}</span>
    </div>
    <span class="text-border">|</span>
    <div class="flex items-center gap-1.5">
      <span class="text-muted-foreground">Duration:</span>
      <span class="text-foreground">{formatDuration(session.wall_clock_seconds)}</span>
    </div>
    {#if session.trace_id}
      <span class="text-border">|</span>
      <button
        class="text-chart-1 underline underline-offset-2 hover:text-chart-1/80 text-xs"
        onclick={loadTrace}
      >
        {traceOpen ? "Hide Trace" : "View Trace"}
      </button>
    {/if}
  </div>

  <!-- Inline trace view -->
  {#if traceOpen}
    <div class="mt-3 rounded-lg bg-muted/50 p-4">
      <p class="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Trace: {session.trace_id}
      </p>
      {#if traceLoading}
        <div class="flex items-center gap-2 py-4">
          <div class="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
          <span class="text-xs text-muted-foreground">Loading trace...</span>
        </div>
      {:else if traceSessions.length === 0}
        <p class="text-xs text-muted-foreground">No related sessions found.</p>
      {:else}
        <div class="space-y-2">
          {#each traceSessions as ts}
            <div class="flex items-center gap-3 rounded-md bg-background px-3 py-2 text-xs">
              <span class="font-mono text-muted-foreground">{(ts.session_id || "").slice(0, 12)}</span>
              <Badge variant={ts.status === "error" ? "destructive" : "secondary"}>{ts.status || "done"}</Badge>
              <span class="text-muted-foreground">{ts.agent_name || ""}</span>
              {#if ts.depth && ts.depth > 0}
                <span class="text-muted-foreground">depth:{ts.depth}</span>
              {/if}
              <span class="ml-auto text-muted-foreground">{formatCost(ts.cost_total_usd)}</span>
              <span class="text-muted-foreground">{timeAgo(ts.created_at)}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Turn-by-turn transcript -->
  <div class="space-y-4">
    {#each turns as turn (turn.turn_number)}
      <div class="rounded-lg border border-border bg-card">
        <!-- Turn header -->
        <div class="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs">
          <span class="font-semibold text-foreground">Turn {turn.turn_number}</span>
          <Badge variant={turn.execution_mode === "llm" ? "secondary" : "outline"}>
            {turn.execution_mode}
          </Badge>
          {#if turn.model_used}
            <span class="text-muted-foreground">{turn.model_used}</span>
          {/if}
          {#if turn.latency_ms}
            <span class="ml-auto text-muted-foreground">{turn.latency_ms}ms</span>
          {/if}
        </div>

        <div class="space-y-3 p-4">
          <!-- LLM content -->
          {#if turn.content}
            {#if turn.execution_mode === "llm" && renderedContent.get(turn.turn_number)}
              <div class="prose prose-sm max-w-none text-card-foreground dark:prose-invert">
                {@html renderedContent.get(turn.turn_number)}
              </div>
            {:else}
              <p class="whitespace-pre-wrap text-sm text-card-foreground">{turn.content}</p>
            {/if}
          {/if}

          <!-- Tool calls -->
          {#if turn.tool_calls?.length}
            <div class="space-y-2">
              {#each turn.tool_calls as tc, i (`${turn.turn_number}-${i}`)}
                <ToolCallBlock toolCall={normalizeToolCall(tc, i)} expanded={false} />
              {/each}
            </div>
          {/if}

          <!-- Error -->
          {#if turn.reflection?.error}
            <div class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {turn.reflection.error}
            </div>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>
