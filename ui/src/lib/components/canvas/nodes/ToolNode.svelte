<script lang="ts">
  import { Handle, Position } from "@xyflow/svelte";

  interface Props {
    data: {
      toolId: string;
      name: string;
      description: string;
      icon: string;
    };
  }

  let { data }: Props = $props();
</script>

<div
  class="flex items-center gap-3 rounded-lg border border-border bg-card p-3 shadow-sm"
  style="width: 180px; min-height: 70px;"
>
  <Handle type="source" position={Position.Top} class="!bg-muted-foreground !w-2.5 !h-2.5" />

  <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d={data.icon} />
    </svg>
  </div>

  <div class="min-w-0">
    <p class="truncate text-xs font-medium text-foreground">{data.name}</p>
    <p class="truncate text-[10px] text-muted-foreground">{data.description}</p>
  </div>
</div>
