<script lang="ts">
  import { page } from "$app/stores";
  import { api } from "$lib/services/api";
  import Badge from "$lib/components/ui/badge.svelte";

  let trace: any = $state(null);
  let loading = $state(true);
  let error = $state("");

  const traceId = $derived($page.params.id);

  $effect(() => {
    if (!traceId) return;
    loading = true;
    error = "";
    api.get<any>(`/sessions/${traceId}/trace`)
      .then(data => { trace = data; })
      .catch(err => { error = err.message || "Failed to load trace"; })
      .finally(() => { loading = false; });
  });

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  function formatCost(usd: number): string {
    return `$${Number(usd || 0).toFixed(4)}`;
  }

  function formatDuration(ms: number): string {
    if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
    if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
    return `${ms}ms`;
  }
</script>

<div class="mx-auto max-w-5xl p-6">
  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div class="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-foreground"></div>
      <span class="ml-3 text-sm text-muted-foreground">Loading trace...</span>
    </div>
  {:else if error}
    <div class="rounded-lg border border-destructive/20 bg-destructive/5 p-6 text-center">
      <p class="text-sm text-destructive">{error}</p>
      <a href="/sessions" class="mt-2 inline-block text-sm text-muted-foreground hover:underline">Back to sessions</a>
    </div>
  {:else if trace?.session}
    {@const s = trace.session}

    <!-- Header -->
    <div class="mb-8">
      <div class="flex items-center gap-3 mb-2">
        <h1 class="text-xl font-semibold">Session Trace</h1>
        <Badge variant={s.status === "completed" ? "default" : s.status === "failed" ? "destructive" : "secondary"}>
          {s.status}
        </Badge>
      </div>
      <p class="text-sm text-muted-foreground">
        {s.agent_name} · {s.model} · {new Date(s.created_at).toLocaleString()}
      </p>
    </div>

    <!-- Stats -->
    <div class="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="rounded-lg border bg-card p-4">
        <p class="text-xs text-muted-foreground">Turns</p>
        <p class="text-2xl font-semibold">{s.turn_count}</p>
      </div>
      <div class="rounded-lg border bg-card p-4">
        <p class="text-xs text-muted-foreground">Tool Calls</p>
        <p class="text-2xl font-semibold">{s.tool_call_count}</p>
      </div>
      <div class="rounded-lg border bg-card p-4">
        <p class="text-xs text-muted-foreground">Tokens</p>
        <p class="text-2xl font-semibold">{formatTokens(s.input_tokens + s.output_tokens)}</p>
        <p class="text-xs text-muted-foreground">{formatTokens(s.input_tokens)} in / {formatTokens(s.output_tokens)} out</p>
      </div>
      <div class="rounded-lg border bg-card p-4">
        <p class="text-xs text-muted-foreground">Cost</p>
        <p class="text-2xl font-semibold">{formatCost(s.cost_usd)}</p>
        <p class="text-xs text-muted-foreground">{formatDuration(s.duration_ms)}</p>
      </div>
    </div>

    <!-- Error -->
    {#if s.error}
      <div class="mb-6 rounded-lg border border-destructive/20 bg-destructive/5 p-4">
        <p class="text-xs font-medium text-destructive">Error</p>
        <p class="mt-1 text-sm font-mono">{s.error}</p>
      </div>
    {/if}

    <!-- Timeline -->
    <h2 class="mb-4 text-lg font-semibold">Event Timeline</h2>
    {#if trace.timeline && trace.timeline.length > 0}
      <div class="space-y-2">
        {#each trace.timeline as event, i}
          <div class="flex gap-4 rounded-lg border bg-card p-4">
            <div class="flex flex-col items-center">
              <div class="h-3 w-3 rounded-full {event.type?.includes('error') || event.type?.includes('fail') ? 'bg-destructive' : event.type?.includes('tool') ? 'bg-amber-500' : 'bg-primary'}"></div>
              {#if i < trace.timeline.length - 1}
                <div class="mt-1 h-full w-px bg-border"></div>
              {/if}
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium">{event.type || "event"}</span>
                {#if event.tool_name}
                  <Badge variant="outline">{event.tool_name}</Badge>
                {/if}
                {#if event.duration_ms}
                  <span class="text-xs text-muted-foreground">{formatDuration(event.duration_ms)}</span>
                {/if}
                {#if event.cost_usd}
                  <span class="text-xs text-muted-foreground">{formatCost(event.cost_usd)}</span>
                {/if}
              </div>
              {#if event.detail || event.args || event.result}
                <pre class="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 text-xs font-mono">{JSON.stringify(event.detail || event.args || event.result, null, 2)}</pre>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="rounded-lg border bg-card p-8 text-center">
        <p class="text-sm text-muted-foreground">No detailed events available for this session.</p>
        <p class="mt-1 text-xs text-muted-foreground">Events are populated by the telemetry pipeline. Check back after more sessions complete.</p>
      </div>
    {/if}

    <!-- Cost Breakdown -->
    {#if trace.cost_breakdown}
      <h2 class="mt-8 mb-4 text-lg font-semibold">Cost Breakdown</h2>
      <div class="rounded-lg border bg-card">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b text-left text-xs text-muted-foreground">
              <th class="p-3">Step</th>
              <th class="p-3">Model</th>
              <th class="p-3 text-right">Tokens</th>
              <th class="p-3 text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {#each Object.entries(trace.cost_breakdown) as [step, detail]}
              <tr class="border-b last:border-0">
                <td class="p-3 font-mono text-xs">{step}</td>
                <td class="p-3 text-xs text-muted-foreground">{(detail as any).model || ""}</td>
                <td class="p-3 text-right text-xs">{formatTokens((detail as any).tokens || 0)}</td>
                <td class="p-3 text-right text-xs font-medium">{formatCost((detail as any).cost_usd || 0)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {:else}
    <div class="py-20 text-center">
      <p class="text-sm text-muted-foreground">Session not found</p>
    </div>
  {/if}
</div>
