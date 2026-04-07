<script lang="ts">
  import { toast } from "svelte-sonner";
  import StatCard from "$lib/components/ui/stat-card.svelte";
  import Table from "$lib/components/ui/table.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import {
    getObservabilitySummary,
    getDailyUsage,
    type ObservabilitySummary,
    type DailyUsageDay,
  } from "$lib/services/observability";
  import { formatCost } from "$lib/utils/time";

  let summary = $state<ObservabilitySummary | null>(null);
  let dailyUsage = $state<DailyUsageDay[]>([]);
  let loading = $state(true);

  async function load() {
    loading = true;
    try {
      const [s, d] = await Promise.all([
        getObservabilitySummary(30),
        getDailyUsage(14),
      ]);
      summary = s;
      dailyUsage = d.days;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load observability data");
    } finally {
      loading = false;
    }
  }

  let errorRate = $derived(
    summary ? ((1 - summary.success_rate) * 100).toFixed(1) + "%" : "0%"
  );

  $effect(() => {
    load();
  });
</script>

<div class="mx-auto w-full max-w-5xl px-6 py-8 lg:px-8">
  <!-- Header -->
  <div class="mb-8">
    <h1>Observability</h1>
    <p class="mt-1.5 text-sm text-muted-foreground">
      Platform health, cost overview, and usage trends.
    </p>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-24">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
    </div>
  {:else}
    <!-- Stat cards -->
    <div class="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        value={summary ? String(summary.total_sessions) : "0"}
        label="Total Sessions"
        subtitle="Last 30 days"
        accentColor="chart-1"
      />
      <StatCard
        value={errorRate}
        label="Error Rate"
        subtitle="Last 30 days"
        accentColor="destructive"
      />
      <StatCard
        value={summary ? `${summary.avg_latency_seconds.toFixed(1)}s` : "0s"}
        label="Avg Latency"
        subtitle="Last 30 days"
        accentColor="chart-3"
      />
      <StatCard
        value={summary ? formatCost(summary.total_cost_usd) : "$0.00"}
        label="Total Cost"
        subtitle="Last 30 days"
        accentColor="chart-2"
      />
    </div>

    <!-- Token usage summary -->
    {#if summary}
      <div class="mb-8 rounded-lg border border-border bg-card p-6">
        <h3 class="mb-3 text-sm font-medium text-foreground">Token Usage (30 days)</h3>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <p class="text-2xl font-bold text-foreground">{summary.total_input_tokens.toLocaleString()}</p>
            <p class="text-xs text-muted-foreground">Input Tokens</p>
          </div>
          <div>
            <p class="text-2xl font-bold text-foreground">{summary.total_output_tokens.toLocaleString()}</p>
            <p class="text-xs text-muted-foreground">Output Tokens</p>
          </div>
        </div>
      </div>
    {/if}

    <!-- Daily usage table -->
    <div>
      <h2 class="mb-4">Daily Usage (14 days)</h2>
      {#if dailyUsage.length === 0}
        <div class="rounded-lg border border-dashed border-border py-12 text-center">
          <p class="text-sm text-muted-foreground">No usage data available yet.</p>
        </div>
      {:else}
        <Table>
          {#snippet thead()}
            <tr>
              <th class="px-4 py-3">Date</th>
              <th class="px-4 py-3">Cost</th>
              <th class="px-4 py-3">Calls</th>
              <th class="px-4 py-3">Input Tokens</th>
              <th class="px-4 py-3">Output Tokens</th>
            </tr>
          {/snippet}
          {#snippet tbody()}
            {#each dailyUsage as day}
              <tr class="hover:bg-muted/30">
                <td class="px-4 py-3 font-medium text-foreground">{day.day}</td>
                <td class="px-4 py-3 text-muted-foreground">{formatCost(day.cost)}</td>
                <td class="px-4 py-3 text-muted-foreground">{day.call_count}</td>
                <td class="px-4 py-3 text-muted-foreground">{day.input_tokens.toLocaleString()}</td>
                <td class="px-4 py-3 text-muted-foreground">{day.output_tokens.toLocaleString()}</td>
              </tr>
            {/each}
          {/snippet}
        </Table>
      {/if}
    </div>
  {/if}
</div>
