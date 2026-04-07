<script lang="ts">
  import { goto } from "$app/navigation";
  import { agentStore } from "$lib/stores/agents.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import StatCard from "$lib/components/ui/stat-card.svelte";
  import {
    getStats,
    getActivity,
    type DashboardStats,
    type ActivityItem,
  } from "$lib/services/dashboard";
  import { timeAgo, formatCost } from "$lib/utils/time";

  let stats = $state<DashboardStats | null>(null);
  let activity = $state<ActivityItem[]>([]);
  let loadingStats = $state(true);

  function planVariant(plan: string): "free" | "basic" | "standard" | "premium" {
    const p = plan?.toLowerCase();
    if (p === "free") return "free";
    if (p === "basic") return "basic";
    if (p === "premium") return "premium";
    return "standard";
  }

  function activityIcon(type: string): string {
    if (type === "error") return "destructive";
    if (type === "eval") return "chart-3";
    return "muted-foreground";
  }

  $effect(() => {
    const load = async () => {
      loadingStats = true;
      try {
        const [statsData, activityData] = await Promise.all([
          getStats().catch(() => null),
          getActivity(10).catch(() => ({ items: [] })),
        ]);
        stats = statsData;
        activity = activityData.items ?? [];
      } finally {
        loadingStats = false;
      }
    };
    load();
  });
</script>

<div class="mx-auto w-full max-w-7xl px-6 py-8 lg:px-8">
  <!-- Header -->
  <div class="mb-8">
    <h1>Dashboard</h1>
    <p class="mt-1.5 text-sm text-muted-foreground">
      Overview of your OneShots agents and activity
    </p>
  </div>

  <!-- Stat cards row -->
  <div class="mb-8 grid gap-4 grid-cols-2 lg:grid-cols-4">
    {#if loadingStats}
      {#each Array(4) as _}
        <div class="h-24 animate-pulse rounded-lg border border-border bg-muted/30"></div>
      {/each}
    {:else if stats}
      <StatCard
        value={String(stats.total_agents ?? 0)}
        label="Total Agents"
        subtitle="{stats.live_agents ?? 0} live"
        accentColor="chart-1"
      />
      <StatCard
        value={String(stats.total_sessions ?? 0)}
        label="Total Sessions"
        subtitle="{stats.active_sessions ?? 0} active"
        accentColor="chart-2"
      />
      <StatCard
        value={formatCost(stats.total_cost_usd ?? 0)}
        label="Total Cost"
        accentColor="chart-3"
      />
      <StatCard
        value="{Math.round(stats.avg_latency_ms ?? 0)}ms"
        label="Avg Latency"
        subtitle="{(stats.error_rate_pct ?? 0).toFixed(1)}% error rate"
        accentColor="chart-4"
      />
    {:else}
      <StatCard value="--" label="Total Agents" accentColor="chart-1" />
      <StatCard value="--" label="Total Sessions" accentColor="chart-2" />
      <StatCard value="--" label="Total Cost" accentColor="chart-3" />
      <StatCard value="--" label="Avg Latency" accentColor="chart-4" />
    {/if}
  </div>

  <!-- Your Agents section -->
  <div class="mb-8">
    <div class="mb-4 flex items-center justify-between">
      <h2>Your Agents</h2>
      <span class="text-sm text-muted-foreground">
        {agentStore.agents.length} agent{agentStore.agents.length !== 1 ? "s" : ""}
      </span>
    </div>

    {#if agentStore.loading}
      <div class="flex items-center justify-center py-16">
        <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
      </div>
    {:else}
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#each agentStore.agents as agent}
          <button
            class="group flex flex-col items-start rounded-xl border border-border bg-card p-5 text-left transition-all hover:border-foreground/20 hover:shadow-sm active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onclick={() => goto(`/chat/${agent.name}`)}
          >
            <div class="flex w-full items-start justify-between">
              <div class="flex items-center gap-2.5">
                <span class="h-2.5 w-2.5 shrink-0 rounded-full {agent.is_active ? 'bg-success' : 'bg-muted-foreground/30'}"></span>
                <span class="font-medium text-card-foreground">{agent.name}</span>
              </div>
              <!-- Plan badge hidden for MVP -->
            </div>

            <p class="mt-3 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
              {agent.description || "No description"}
            </p>

            <div class="mt-auto flex w-full items-center gap-3 pt-4 text-xs text-muted-foreground">
              <span>{agent.tools?.length ?? 0} tools</span>
              <span class="text-border">·</span>
              <span>v{agent.version || "0.1.0"}</span>
              {#if agent.tags?.length}
                <span class="text-border">·</span>
                <span class="truncate">{agent.tags.slice(0, 2).join(", ")}</span>
              {/if}
            </div>
          </button>
        {/each}

        <!-- Create new agent -->
        <button
          class="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border p-8 text-muted-foreground transition-all hover:border-foreground/30 hover:text-foreground active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          onclick={() => goto("/agent/new")}
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="mb-2 h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          <span class="text-sm font-medium">Create Agent</span>
        </button>
      </div>
    {/if}
  </div>

  <!-- Recent Activity feed -->
  <div>
    <div class="mb-4 flex items-center justify-between">
      <h2>Recent Activity</h2>
      {#if activity.length > 0}
        <span class="text-sm text-muted-foreground">Latest</span>
      {/if}
    </div>

    {#if loadingStats}
      <div class="space-y-2">
        {#each Array(5) as _}
          <div class="h-12 animate-pulse rounded-lg border border-border bg-muted/30"></div>
        {/each}
      </div>
    {:else if activity.length === 0}
      <div class="rounded-lg border border-dashed border-border py-10 text-center">
        <p class="text-sm text-muted-foreground">No recent activity</p>
      </div>
    {:else}
      <div class="divide-y divide-border rounded-lg border border-border bg-card">
        {#each activity as item (item.id)}
          <div class="flex items-center gap-3 px-4 py-3">
            <!-- Icon -->
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full {item.type === 'error' ? 'bg-destructive/10' : 'bg-muted'}">
              {#if item.type === "error"}
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-destructive" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
              {:else if item.type === "eval"}
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-chart-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
                  <rect x="9" y="3" width="6" height="4" rx="2" />
                  <path d="M9 14l2 2 4-4" />
                </svg>
              {:else}
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                </svg>
              {/if}
            </div>
            <!-- Content -->
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm text-foreground">{item.message}</p>
              <p class="text-xs text-muted-foreground">{item.agent_name}</p>
            </div>
            <!-- Time -->
            <span class="shrink-0 text-xs text-muted-foreground">{timeAgo(item.created_at)}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
