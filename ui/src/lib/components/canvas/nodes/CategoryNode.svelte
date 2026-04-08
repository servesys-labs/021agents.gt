<script lang="ts">
  import { Handle, Position } from "@xyflow/svelte";

  interface Props {
    data: {
      label: string;
      icon: string;
      count: number;
      items: string[];
      color: string;
      accent: string;
    };
  }

  let { data }: Props = $props();
  let expanded = $state(false);
</script>

<div
  class="relative rounded-xl border-2 bg-card/95 shadow-md backdrop-blur-sm transition-all duration-200 hover:shadow-lg {data.accent}"
  style="min-width: 160px; max-width: 240px;"
>
  <Handle type="target" position={Position.Top} class="!bg-muted-foreground/60 !h-2 !w-2 !border-background" />

  <!-- Header — always visible -->
  <button
    class="flex w-full items-center gap-3 p-3 text-left"
    onclick={() => (expanded = !expanded)}
  >
    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg {data.color}">
      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d={data.icon} />
      </svg>
    </span>
    <div class="min-w-0 flex-1">
      <p class="text-xs font-semibold text-foreground">{data.label}</p>
      <p class="text-[10px] text-muted-foreground">{data.count} active</p>
    </div>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200"
      class:rotate-180={expanded}
      fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
    >
      <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  </button>

  <!-- Expanded item list -->
  {#if expanded && data.items.length > 0}
    <div class="border-t border-border px-3 pb-2 pt-1">
      <div class="max-h-48 space-y-0.5 overflow-y-auto">
        {#each data.items as item}
          <p class="truncate rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/30 hover:text-foreground">
            {item}
          </p>
        {/each}
      </div>
    </div>
  {/if}

  <Handle type="source" position={Position.Bottom} class="!bg-muted-foreground/60 !h-2 !w-2 !border-background" />
</div>
