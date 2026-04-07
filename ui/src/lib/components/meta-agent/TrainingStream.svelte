<script lang="ts">
  import { streamTrainingProgress, type TrainingEvent } from "$lib/services/training";
  import Button from "$lib/components/ui/button.svelte";

  interface Props {
    jobId: string;
    agentName: string;
    onComplete?: () => void;
  }

  let { jobId, agentName, onComplete }: Props = $props();

  interface LogLine {
    text: string;
    color: "blue" | "green" | "red" | "yellow" | "muted";
  }

  let lines = $state<LogLine[]>([]);
  let currentIteration = $state(0);
  let maxIterations = $state(0);
  let latestPassRate = $state<number | undefined>(undefined);
  let latestReward = $state<number | undefined>(undefined);
  let latestCost = $state<number | undefined>(undefined);
  let finished = $state(false);
  let containerEl: HTMLDivElement | undefined = $state();
  let abortFn: (() => void) | null = null;

  function addLine(text: string, color: LogLine["color"] = "muted") {
    lines = [...lines, { text, color }];
    requestAnimationFrame(() => {
      if (containerEl) {
        containerEl.scrollTop = containerEl.scrollHeight;
      }
    });
  }

  function handleEvent(event: TrainingEvent) {
    const d = event.data;

    switch (event.type) {
      case "iteration_start": {
        const iter = (d as { iteration?: number }).iteration ?? 0;
        const max = (d as { max_iterations?: number }).max_iterations ?? 0;
        currentIteration = iter;
        if (max) maxIterations = max;
        addLine(`--- Iteration ${iter}/${maxIterations || "?"} ---`, "blue");
        break;
      }
      case "eval_result": {
        const pass = (d as { passed?: boolean }).passed;
        const testName = (d as { test_name?: string }).test_name ?? "test";
        const reason = (d as { reason?: string }).reason ?? "";
        if (pass) {
          addLine(`  PASS  ${testName}${reason ? ` - ${reason}` : ""}`, "green");
        } else {
          addLine(`  FAIL  ${testName}${reason ? ` - ${reason}` : ""}`, "red");
        }
        break;
      }
      case "iteration_end": {
        const passRate = (d as { pass_rate?: number }).pass_rate;
        const reward = (d as { reward_score?: number }).reward_score;
        const cost = (d as { cost_usd?: number }).cost_usd;
        if (passRate !== undefined) latestPassRate = passRate;
        if (reward !== undefined) latestReward = reward;
        if (cost !== undefined) latestCost = cost;
        addLine(
          `  Summary: pass_rate=${(passRate ?? 0).toFixed(1)}% reward=${(reward ?? 0).toFixed(3)} cost=$${(cost ?? 0).toFixed(4)}`,
          "muted"
        );
        break;
      }
      case "optimization": {
        const change = (d as { description?: string }).description ?? "optimizing...";
        addLine(`  >> ${change}`, "yellow");
        break;
      }
      case "complete": {
        const bestScore = (d as { best_score?: number }).best_score;
        addLine(`\nTraining complete. Best score: ${(bestScore ?? 0).toFixed(3)}`, "green");
        finished = true;
        onComplete?.();
        break;
      }
      case "error": {
        const msg = (d as { message?: string }).message ?? "Unknown error";
        addLine(`ERROR: ${msg}`, "red");
        finished = true;
        break;
      }
    }
  }

  function stopTraining() {
    abortFn?.();
    abortFn = null;
    addLine("\nTraining stopped by user.", "yellow");
    finished = true;
  }

  $effect(() => {
    if (!jobId) return;
    lines = [];
    finished = false;
    currentIteration = 0;
    addLine(`Starting training for ${agentName} (job: ${jobId})...`, "blue");

    const { abort } = streamTrainingProgress(jobId, handleEvent);
    abortFn = abort;

    return () => {
      abort();
    };
  });

  let progressPct = $derived(
    maxIterations > 0 ? Math.round((currentIteration / maxIterations) * 100) : 0
  );

  const colorMap: Record<LogLine["color"], string> = {
    blue: "text-chart-1",
    green: "text-success",
    red: "text-destructive",
    yellow: "text-chart-4",
    muted: "text-muted-foreground",
  };
</script>

<div class="flex flex-col gap-3">
  <!-- Progress bar -->
  {#if maxIterations > 0}
    <div class="flex items-center gap-3">
      <div class="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          class="h-full rounded-full bg-primary transition-all duration-300"
          style="width: {progressPct}%"
        ></div>
      </div>
      <span class="shrink-0 text-xs text-muted-foreground">
        {currentIteration}/{maxIterations}
      </span>
    </div>
  {/if}

  <!-- Stats row -->
  {#if latestPassRate !== undefined || latestReward !== undefined}
    <div class="flex gap-4 text-xs">
      {#if latestPassRate !== undefined}
        <span class="text-muted-foreground">
          Pass rate: <span class="font-medium text-foreground">{(latestPassRate ?? 0).toFixed(1)}%</span>
        </span>
      {/if}
      {#if latestReward !== undefined}
        <span class="text-muted-foreground">
          Reward: <span class="font-medium text-foreground">{(latestReward ?? 0).toFixed(3)}</span>
        </span>
      {/if}
      {#if latestCost !== undefined}
        <span class="text-muted-foreground">
          Cost: <span class="font-medium text-foreground">${(latestCost ?? 0).toFixed(4)}</span>
        </span>
      {/if}
    </div>
  {/if}

  <!-- Terminal output -->
  <div
    bind:this={containerEl}
    class="max-h-64 overflow-y-auto rounded-lg bg-code-background p-3 font-mono text-xs leading-relaxed"
  >
    {#each lines as line}
      <div class={colorMap[line.color]}>{line.text}</div>
    {/each}
    {#if !finished}
      <span class="inline-block h-3.5 w-1.5 animate-pulse bg-foreground"></span>
    {/if}
  </div>

  <!-- Stop button -->
  {#if !finished}
    <Button variant="destructive" size="sm" onclick={stopTraining}>
      <svg xmlns="http://www.w3.org/2000/svg" class="mr-1.5 h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="6" width="12" height="12" rx="1" />
      </svg>
      Stop Training
    </Button>
  {/if}
</div>
