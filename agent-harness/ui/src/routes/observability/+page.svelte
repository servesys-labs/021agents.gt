<script lang="ts">
  import { toast } from "svelte-sonner";
  import StatCard from "$lib/components/ui/stat-card.svelte";
  import Table from "$lib/components/ui/table.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import {
    getObservabilitySummary,
    type ObservabilitySummary,
  } from "$lib/services/observability";
  import { formatCost } from "$lib/utils/time";

  let summary = $state<ObservabilitySummary | null>(null);
  let loading = $state(true);
  let topModels = $derived(summary?.top_models ?? []);
  let topAgents = $derived(summary?.top_agents ?? []);
  let dailyPoints = $derived(summary?.daily ?? []);

  async function load() {
    loading = true;
    try {
      summary = await getObservabilitySummary(30);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load observability data");
    } finally {
      loading = false;
    }
  }

  let errorRate = $derived(
    summary ? ((1 - summary.success_rate) * 100).toFixed(1) + "%" : "0%"
  );

  let totalTokens = $derived(
    summary ? (summary.total_input_tokens + summary.total_output_tokens).toLocaleString() : "0"
  );

  $effect(() => {
    load();
  });
</script>

<div class="w-full px-6 py-8 lg:px-8">
  <div class="mb-8">
    <h1>Observability</h1>
    <p class="mt-1.5 text-sm text-muted-foreground">
      Platform health, usage, and performance — last 30 days.
    </p>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-24">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
    </div>
  {:else if summary}
    <!-- Stat cards row 1 -->
    <div class="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        value={String(summary.total_sessions)}
        label="Sessions"
        accentColor="chart-1"
      />
      <StatCard
        value={String(summary.total_steps)}
        label="Total Steps"
        accentColor="chart-2"
      />
      <StatCard
        value={totalTokens}
        label="Total Tokens"
        accentColor="chart-3"
      />
      <StatCard
        value={`${Number(summary.avg_latency_seconds || 0).toFixed(1)}s`}
        label="Avg Session Duration"
        accentColor="chart-4"
      />
    </div>

    <!-- Stat cards row 2 -->
    <div class="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        value={`${Number((summary.success_rate || 0) * 100).toFixed(0)}%`}
        label="Success Rate"
        accentColor="chart-1"
      />
      <StatCard
        value={String(summary.error_count)}
        label="Errors"
        accentColor="chart-5"
      />
      <StatCard
        value={`${Number(summary.avg_turn_latency_ms || 0).toFixed(0)}ms`}
        label="Avg Turn Latency"
        accentColor="chart-3"
      />
      <StatCard
        value={String(summary.models_used)}
        label="Models Used"
        accentColor="chart-4"
      />
    </div>

    <!-- Token breakdown -->
    <div class="mb-8 rounded-lg border border-border bg-card p-6">
      <h3 class="mb-4 text-sm font-medium text-foreground">Token Usage</h3>
      <div class="grid gap-6 sm:grid-cols-3">
        <div>
          <p class="text-2xl font-bold text-foreground">{summary.total_input_tokens.toLocaleString()}</p>
          <p class="text-xs text-muted-foreground">Input Tokens</p>
        </div>
        <div>
          <p class="text-2xl font-bold text-foreground">{summary.total_output_tokens.toLocaleString()}</p>
          <p class="text-xs text-muted-foreground">Output Tokens</p>
        </div>
        <div>
          <p class="text-2xl font-bold text-foreground">{formatCost(summary.total_cost_usd)}</p>
          <p class="text-xs text-muted-foreground">Total Cost</p>
        </div>
      </div>
    </div>

    <!-- Top Models -->
    {#if topModels.length > 0}
      <div class="mb-8">
        <h2 class="mb-4">Models</h2>
        <Table>
          {#snippet thead()}
            <tr>
              <th class="px-4 py-3">Model</th>
              <th class="px-4 py-3 text-right">Turns</th>
              <th class="px-4 py-3 text-right">Input Tokens</th>
              <th class="px-4 py-3 text-right">Output Tokens</th>
            </tr>
          {/snippet}
          {#snippet tbody()}
            {#each topModels as m}
              <tr class="hover:bg-muted/30">
                <td class="px-4 py-3">
                  <Badge variant="secondary">{m.model}</Badge>
                </td>
                <td class="px-4 py-3 text-right text-muted-foreground">{m.turns}</td>
                <td class="px-4 py-3 text-right text-muted-foreground">{m.input_tokens.toLocaleString()}</td>
                <td class="px-4 py-3 text-right text-muted-foreground">{m.output_tokens.toLocaleString()}</td>
              </tr>
            {/each}
          {/snippet}
        </Table>
      </div>
    {/if}

    <!-- Top Agents -->
    {#if topAgents.length > 0}
      <div class="mb-8">
        <h2 class="mb-4">Agents</h2>
        <Table>
          {#snippet thead()}
            <tr>
              <th class="px-4 py-3">Agent</th>
              <th class="px-4 py-3 text-right">Sessions</th>
              <th class="px-4 py-3 text-right">Steps</th>
              <th class="px-4 py-3 text-right">Avg Duration</th>
            </tr>
          {/snippet}
          {#snippet tbody()}
            {#each topAgents as a}
              <tr class="hover:bg-muted/30">
                <td class="px-4 py-3 font-medium">{a.agent}</td>
                <td class="px-4 py-3 text-right text-muted-foreground">{a.sessions}</td>
                <td class="px-4 py-3 text-right text-muted-foreground">{a.steps}</td>
                <td class="px-4 py-3 text-right text-muted-foreground">{Number(a.avg_latency || 0).toFixed(1)}s</td>
              </tr>
            {/each}
          {/snippet}
        </Table>
      </div>
    {/if}

    <!-- Daily Activity -->
    {#if dailyPoints.length > 0}
      <div>
        <h2 class="mb-4">Daily Activity</h2>
        <Table>
          {#snippet thead()}
            <tr>
              <th class="px-4 py-3">Date</th>
              <th class="px-4 py-3 text-right">Sessions</th>
              <th class="px-4 py-3 text-right">Steps</th>
              <th class="px-4 py-3 text-right">Cost</th>
            </tr>
          {/snippet}
          {#snippet tbody()}
            {#each dailyPoints as d}
              <tr class="hover:bg-muted/30">
                <td class="px-4 py-3 font-medium text-foreground">{d.day}</td>
                <td class="px-4 py-3 text-right text-muted-foreground">{d.sessions}</td>
                <td class="px-4 py-3 text-right text-muted-foreground">{d.steps}</td>
                <td class="px-4 py-3 text-right text-muted-foreground">{formatCost(d.cost)}</td>
              </tr>
            {/each}
          {/snippet}
        </Table>
      </div>
    {/if}
  {/if}
</div>
