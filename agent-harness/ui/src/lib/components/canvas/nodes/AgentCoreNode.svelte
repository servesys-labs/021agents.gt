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
      pulsing?: boolean;
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
  class="agent-canvas-core flex flex-col items-center justify-center rounded-xl border-2 border-primary bg-card p-4 shadow-lg"
  class:core-pulsing={data.pulsing}
  style="width: 320px; min-height: 200px;"
>
  <!-- Four handles with explicit IDs. The core sits in the middle of the
       layout, so it needs to be both a target (for tier 1 / tier 3 inputs)
       and a source (for tier 4 sinks). Multiple handles at the same
       position are allowed by xyflow as long as IDs differ. -->
  <Handle id="top-target" type="target" position={Position.Top} class="!bg-primary !w-3 !h-3" />
  <Handle id="bottom-target" type="target" position={Position.Bottom} class="!bg-primary !w-3 !h-3" />
  <Handle id="bottom-source" type="source" position={Position.Bottom} class="!bg-primary !w-3 !h-3 !opacity-0" />
  <Handle id="left-target" type="target" position={Position.Left} class="!bg-primary !w-3 !h-3 !opacity-0" />
  <Handle id="right-target" type="target" position={Position.Right} class="!bg-primary !w-3 !h-3 !opacity-0" />

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

<style>
  /* Core node has a slightly stronger glow than capability satellites —
     it's the center of attention by default, and it becomes even more
     prominent when pulsing during the Result step. */
  :global(.agent-canvas-core) {
    box-shadow:
      0 0 40px -10px hsl(var(--primary) / 0.35),
      0 10px 30px -10px hsl(var(--foreground) / 0.15);
  }
  :global(.core-pulsing) {
    animation: core-pulse 1.6s ease-in-out infinite;
  }
  @keyframes core-pulse {
    0%, 100% {
      box-shadow:
        0 0 0 0 hsl(var(--primary) / 0.5),
        0 0 40px -10px hsl(var(--primary) / 0.45),
        0 10px 30px -10px hsl(var(--foreground) / 0.15);
    }
    50% {
      box-shadow:
        0 0 0 10px hsl(var(--primary) / 0),
        0 0 60px -10px hsl(var(--primary) / 0.6),
        0 10px 30px -10px hsl(var(--foreground) / 0.15);
    }
  }
</style>
