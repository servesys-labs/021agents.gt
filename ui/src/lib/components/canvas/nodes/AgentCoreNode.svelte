<script lang="ts">
  import { Handle, Position } from "@xyflow/svelte";

  interface Props {
    data: {
      agentName: string;
      plan: string;
      modelOverride: string;
      budgetLimit: number;
      maxTurns: number;
      isActive: boolean;
    };
  }

  let { data }: Props = $props();

  const planColors: Record<string, string> = {
    free: "bg-muted text-muted-foreground",
    basic: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    standard: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    premium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  };

  let planClass = $derived(planColors[data.plan] ?? planColors.free);
  let modelLabel = $derived(data.modelOverride || "Auto-routed");
  let budgetLabel = $derived(data.budgetLimit > 0 ? `$${data.budgetLimit} limit` : "No limit");
</script>

<div
  class="flex flex-col items-center justify-center rounded-xl border-2 border-primary bg-card p-4 shadow-lg"
  style="width: 280px; min-height: 180px;"
>
  <Handle type="target" position={Position.Top} class="!bg-primary !w-3 !h-3" />
  <Handle type="target" position={Position.Left} class="!bg-primary !w-3 !h-3" />
  <Handle type="target" position={Position.Right} class="!bg-primary !w-3 !h-3" />
  <Handle type="target" position={Position.Bottom} class="!bg-primary !w-3 !h-3" />

  <div class="flex items-center gap-2">
    {#if !data.isActive}
      <span class="h-2 w-2 rounded-full bg-muted-foreground" title="Inactive"></span>
    {:else}
      <span class="h-2 w-2 rounded-full bg-success" title="Active"></span>
    {/if}
    <h2 class="text-lg font-semibold text-foreground truncate max-w-[220px]">
      {data.agentName}
    </h2>
  </div>

  <span class="mt-2 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium {planClass}">
    {data.plan.charAt(0).toUpperCase() + data.plan.slice(1)}
  </span>

  <p class="mt-2 text-xs text-muted-foreground">{modelLabel}</p>

  <div class="mt-3 flex gap-3">
    <span class="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      {budgetLabel}
    </span>
    <span class="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      {data.maxTurns} turns
    </span>
  </div>
</div>
