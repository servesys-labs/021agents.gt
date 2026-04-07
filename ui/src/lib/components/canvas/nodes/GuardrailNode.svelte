<script lang="ts">
  import { Handle, Position } from "@xyflow/svelte";

  interface Props {
    data: {
      budgetEnabled: boolean;
      budgetLimit: number;
      timeoutSeconds: number;
    };
  }

  let { data }: Props = $props();

  let budgetLabel = $derived(
    data.budgetEnabled && data.budgetLimit > 0
      ? `$${data.budgetLimit.toFixed(2)}`
      : "Unlimited"
  );

  let timeoutLabel = $derived(
    data.timeoutSeconds > 0
      ? `${Math.round(data.timeoutSeconds / 60)} min`
      : "None"
  );
</script>

<div
  class="rounded-lg border border-border border-l-4 border-l-destructive bg-card p-4 shadow-sm"
  style="width: 200px; min-height: 90px;"
>
  <Handle type="source" position={Position.Left} class="!bg-destructive !w-2.5 !h-2.5" />

  <p class="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
    Guardrails
  </p>

  <div class="space-y-1.5">
    <div class="flex items-center justify-between">
      <span class="text-xs text-muted-foreground">Budget</span>
      <span class="text-xs font-medium text-foreground">{budgetLabel}</span>
    </div>
    <div class="flex items-center justify-between">
      <span class="text-xs text-muted-foreground">Timeout</span>
      <span class="text-xs font-medium text-foreground">{timeoutLabel}</span>
    </div>
  </div>
</div>
