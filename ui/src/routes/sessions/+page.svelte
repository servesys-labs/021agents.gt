<script lang="ts">
  import { toast } from "svelte-sonner";
  import Badge from "$lib/components/ui/badge.svelte";
  import Table from "$lib/components/ui/table.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import {
    listSessions,
    getSessionTurns,
    type Session,
    type Turn,
  } from "$lib/services/sessions";
  import { timeAgo, formatDuration, formatCost } from "$lib/utils/time";

  let sessions = $state<Session[]>([]);
  let loading = $state(true);

  // Filters
  let filterAgent = $state("");
  let filterStatus = $state("");

  // Expanded session turns
  let expandedSessionId = $state<string | null>(null);
  let turns = $state<Turn[]>([]);
  let turnsLoading = $state(false);

  const statusVariant: Record<string, "standard" | "destructive" | "secondary" | "free"> = {
    success: "free",
    completed: "free",
    error: "destructive",
    failed: "destructive",
    running: "standard",
    pending: "secondary",
  };

  async function load() {
    loading = true;
    try {
      sessions = await listSessions({
        agent_name: filterAgent || undefined,
        status: filterStatus || undefined,
        limit: 50,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      loading = false;
    }
  }

  async function toggleSession(sessionId: string) {
    if (expandedSessionId === sessionId) {
      expandedSessionId = null;
      turns = [];
      return;
    }
    expandedSessionId = sessionId;
    turnsLoading = true;
    try {
      turns = await getSessionTurns(sessionId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load turns");
      turns = [];
    } finally {
      turnsLoading = false;
    }
  }

  function handleFilter() {
    expandedSessionId = null;
    turns = [];
    load();
  }

  // Unique agent names for filter dropdown
  let agentNames = $derived([...new Set(sessions.map((s) => s.agent_name))].sort());

  $effect(() => {
    load();
  });
</script>

<div class="w-full px-6 py-8 lg:px-8">
  <!-- Header -->
  <div class="mb-8">
    <h1>Sessions</h1>
    <p class="mt-1.5 text-sm text-muted-foreground">
      Browse agent session history and inspect individual turns.
    </p>
  </div>

  <!-- Filters -->
  <div class="mb-6 flex flex-wrap items-center gap-3">
    <div class="w-48">
      <select
        class="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
        bind:value={filterAgent}
        onchange={handleFilter}
      >
        <option value="">All agents</option>
        {#each agentNames as name}
          <option value={name}>{name}</option>
        {/each}
      </select>
    </div>
    <div class="w-40">
      <select
        class="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
        bind:value={filterStatus}
        onchange={handleFilter}
      >
        <option value="">All statuses</option>
        <option value="success">Success</option>
        <option value="completed">Completed</option>
        <option value="error">Error</option>
        <option value="failed">Failed</option>
        <option value="running">Running</option>
        <option value="pending">Pending</option>
      </select>
    </div>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-24">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
    </div>
  {:else if sessions.length === 0}
    <div class="rounded-lg border border-dashed border-border py-16 text-center">
      <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-12 w-12 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <h3 class="mt-4 text-foreground">No sessions yet</h3>
      <p class="mt-1.5 text-sm text-muted-foreground">Sessions will appear here once agents start running.</p>
    </div>
  {:else}
    <Table>
      {#snippet thead()}
        <tr>
          <th class="px-4 py-3">Agent</th>
          <th class="px-4 py-3">Status</th>
          <th class="px-4 py-3">Steps</th>
          <th class="px-4 py-3">Cost</th>
          <th class="px-4 py-3">Duration</th>
          <th class="px-4 py-3">Created</th>
        </tr>
      {/snippet}
      {#snippet tbody()}
        {#each sessions as session}
          <tr
            class="cursor-pointer hover:bg-muted/30 {expandedSessionId === session.session_id ? 'bg-muted/20' : ''}"
            onclick={() => toggleSession(session.session_id)}
          >
            <td class="px-4 py-3 font-medium text-foreground">{session.agent_name}</td>
            <td class="px-4 py-3">
              <Badge variant={statusVariant[session.status] ?? "secondary"}>
                {session.status}
              </Badge>
            </td>
            <td class="px-4 py-3 text-muted-foreground">{session.step_count}</td>
            <td class="px-4 py-3 text-muted-foreground">{formatCost(session.cost_total_usd)}</td>
            <td class="px-4 py-3 text-muted-foreground">{formatDuration(session.wall_clock_seconds)}</td>
            <td class="px-4 py-3 text-muted-foreground">{timeAgo(session.created_at * 1000)}</td>
          </tr>

          <!-- Expanded turns -->
          {#if expandedSessionId === session.session_id}
            <tr>
              <td colspan="6" class="p-0">
                <div class="border-t border-border bg-muted/10 px-6 py-4">
                  {#if session.input_text}
                    <div class="mb-3">
                      <span class="text-xs font-medium text-muted-foreground">Input:</span>
                      <p class="mt-0.5 text-sm text-foreground">{session.input_text}</p>
                    </div>
                  {/if}
                  {#if session.output_text}
                    <div class="mb-4">
                      <span class="text-xs font-medium text-muted-foreground">Output:</span>
                      <p class="mt-0.5 text-sm text-foreground">{session.output_text}</p>
                    </div>
                  {/if}

                  <h4 class="mb-2 text-sm font-medium text-foreground">Turns</h4>
                  {#if turnsLoading}
                    <div class="flex items-center gap-2 py-4">
                      <div class="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
                      <span class="text-sm text-muted-foreground">Loading turns...</span>
                    </div>
                  {:else if turns.length === 0}
                    <p class="py-2 text-sm text-muted-foreground">No turns recorded.</p>
                  {:else}
                    <div class="space-y-2">
                      {#each turns as turn}
                        <div class="rounded-lg border border-border bg-card p-3">
                          <div class="flex flex-wrap items-center gap-3 text-xs">
                            <span class="font-medium text-foreground">Turn {turn.turn_number}</span>
                            <span class="text-muted-foreground">{turn.model_used}</span>
                            <span class="text-muted-foreground">{turn.input_tokens + turn.output_tokens} tokens</span>
                            <span class="text-muted-foreground">{turn.latency_ms}ms</span>
                            <span class="text-muted-foreground">{formatCost(turn.cost_total_usd)}</span>
                          </div>
                          {#if turn.content}
                            <p class="mt-2 text-sm text-muted-foreground line-clamp-3">{turn.content}</p>
                          {/if}
                          {#if (turn.tool_calls ?? []).length > 0}
                            <div class="mt-2 flex flex-wrap gap-1">
                              {#each (turn.tool_calls ?? []) as tc}
                                <span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                                  {(tc as Record<string, unknown>).name || (tc as Record<string, unknown>).tool || "tool"}
                                </span>
                              {/each}
                            </div>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      {/snippet}
    </Table>
  {/if}
</div>
