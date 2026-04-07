<script lang="ts">
  import { toast } from "svelte-sonner";
  import Badge from "$lib/components/ui/badge.svelte";
  import Table from "$lib/components/ui/table.svelte";
  import {
    listEvalRuns,
    getEvalTrials,
    type EvalRun,
    type EvalTrial,
  } from "$lib/services/evals";
  import { formatCost } from "$lib/utils/time";

  let runs = $state<EvalRun[]>([]);
  let loading = $state(true);

  // Expanded run trials
  let expandedRunId = $state<number | null>(null);
  let trials = $state<EvalTrial[]>([]);
  let trialsLoading = $state(false);

  async function load() {
    loading = true;
    try {
      runs = await listEvalRuns(undefined, 50);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load eval runs");
    } finally {
      loading = false;
    }
  }

  async function toggleRun(runId: number) {
    if (expandedRunId === runId) {
      expandedRunId = null;
      trials = [];
      return;
    }
    expandedRunId = runId;
    trialsLoading = true;
    try {
      const result = await getEvalTrials(runId);
      trials = result.trials;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load trials");
      trials = [];
    } finally {
      trialsLoading = false;
    }
  }

  function passRateColor(rate: number): string {
    if (rate >= 0.9) return "text-success";
    if (rate >= 0.7) return "text-chart-4";
    return "text-destructive";
  }

  $effect(() => {
    load();
  });
</script>

<div class="mx-auto w-full max-w-5xl px-6 py-8 lg:px-8">
  <!-- Header -->
  <div class="mb-8">
    <h1>Eval Results</h1>
    <p class="mt-1.5 text-sm text-muted-foreground">
      View evaluation runs and individual trial results.
    </p>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-24">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
    </div>
  {:else if runs.length === 0}
    <div class="rounded-lg border border-dashed border-border py-16 text-center">
      <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-12 w-12 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <h3 class="mt-4 text-foreground">No eval runs yet</h3>
      <p class="mt-1.5 text-sm text-muted-foreground">Run an eval via the API or CLI to see results here.</p>
    </div>
  {:else}
    <Table>
      {#snippet thead()}
        <tr>
          <th class="px-4 py-3">Agent</th>
          <th class="px-4 py-3">Pass Rate</th>
          <th class="px-4 py-3">Avg Score</th>
          <th class="px-4 py-3">Trials</th>
          <th class="px-4 py-3">Avg Latency</th>
          <th class="px-4 py-3">Cost</th>
        </tr>
      {/snippet}
      {#snippet tbody()}
        {#each runs as run}
          <tr
            class="cursor-pointer hover:bg-muted/30 {expandedRunId === run.run_id ? 'bg-muted/20' : ''}"
            onclick={() => toggleRun(run.run_id)}
          >
            <td class="px-4 py-3 font-medium text-foreground">{run.agent_name}</td>
            <td class="px-4 py-3">
              <span class="font-medium {passRateColor(run.pass_rate)}">
                {(run.pass_rate * 100).toFixed(0)}%
              </span>
            </td>
            <td class="px-4 py-3 text-muted-foreground">{(run.avg_score ?? 0).toFixed(2)}</td>
            <td class="px-4 py-3 text-muted-foreground">{run.total_trials}</td>
            <td class="px-4 py-3 text-muted-foreground">{Math.round(run.avg_latency_ms ?? 0)}ms</td>
            <td class="px-4 py-3 text-muted-foreground">{formatCost(run.total_cost_usd)}</td>
          </tr>

          <!-- Expanded trials -->
          {#if expandedRunId === run.run_id}
            <tr>
              <td colspan="6" class="p-0">
                <div class="border-t border-border bg-muted/10 px-6 py-4">
                  <h4 class="mb-3 text-sm font-medium text-foreground">Trials</h4>
                  {#if trialsLoading}
                    <div class="flex items-center gap-2 py-4">
                      <div class="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
                      <span class="text-sm text-muted-foreground">Loading trials...</span>
                    </div>
                  {:else if trials.length === 0}
                    <p class="py-2 text-sm text-muted-foreground">No trials recorded.</p>
                  {:else}
                    <div class="space-y-2">
                      {#each trials as trial}
                        <div class="rounded-lg border border-border bg-card p-3">
                          <div class="flex flex-wrap items-center gap-3 text-xs">
                            <span class="font-medium text-foreground">
                              #{trial.trial_number}
                              {#if trial.task_name}
                                — {trial.task_name}
                              {/if}
                            </span>
                            <Badge variant={trial.passed ? "free" : "destructive"}>
                              {trial.passed ? "passed" : "failed"}
                            </Badge>
                            {#if trial.score != null}
                              <span class="text-muted-foreground">score: {trial.score.toFixed(2)}</span>
                            {/if}
                            {#if trial.latency_ms}
                              <span class="text-muted-foreground">{trial.latency_ms}ms</span>
                            {/if}
                          </div>
                          {#if trial.input}
                            <div class="mt-2">
                              <span class="text-xs font-medium text-muted-foreground">Input:</span>
                              <p class="mt-0.5 text-sm text-foreground line-clamp-2">{trial.input}</p>
                            </div>
                          {/if}
                          {#if trial.expected}
                            <div class="mt-1">
                              <span class="text-xs font-medium text-muted-foreground">Expected:</span>
                              <p class="mt-0.5 text-sm text-muted-foreground line-clamp-2">{trial.expected}</p>
                            </div>
                          {/if}
                          {#if trial.actual}
                            <div class="mt-1">
                              <span class="text-xs font-medium text-muted-foreground">Actual:</span>
                              <p class="mt-0.5 text-sm text-foreground line-clamp-2">{trial.actual}</p>
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
