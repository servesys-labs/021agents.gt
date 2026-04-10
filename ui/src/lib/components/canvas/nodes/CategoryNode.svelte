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
      subtitle?: string;
      /** Long-form description shown on hover (browser native title). */
      tooltip?: string;
      /** Whether this node is the active step in the current run. */
      pulsing?: boolean;
      /** Whether this node is a drop target during tool drag. */
      dropTarget?: boolean;
      /** Tool name being dragged (shown in drop-target preview). */
      dropPreview?: string;
    };
  }

  let { data }: Props = $props();
  let expanded = $state(false);
</script>

<div
  class="agent-canvas-node relative rounded-xl border-2 bg-card/95 shadow-md backdrop-blur-sm transition-all duration-200 hover:shadow-lg {data.accent}"
  class:node-pulsing={data.pulsing}
  class:node-drop-target={data.dropTarget}
  style="min-width: 160px; max-width: 240px;"
  title={data.tooltip}
>
  <!-- Four handles with explicit IDs so edges can pick the geometrically
       closest side. Without these, every edge defaults to top-target +
       bottom-source which forces U-turns when source and target are on
       the same side of the layout. -->
  <Handle id="top-target" type="target" position={Position.Top} class="!bg-muted-foreground/60 !h-2 !w-2 !border-background" />
  <Handle id="top-source" type="source" position={Position.Top} class="!bg-muted-foreground/60 !h-2 !w-2 !border-background !opacity-0" />
  <Handle id="bottom-target" type="target" position={Position.Bottom} class="!bg-muted-foreground/60 !h-2 !w-2 !border-background !opacity-0" />

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
      <p class="text-[10px] text-muted-foreground truncate">
        {data.subtitle ?? `${data.count} active`}
      </p>
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

  <Handle id="bottom-source" type="source" position={Position.Bottom} class="!bg-muted-foreground/60 !h-2 !w-2 !border-background" />

  {#if data.dropTarget && data.dropPreview}
    <div class="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground shadow-lg">
      + {data.dropPreview}
    </div>
  {/if}
</div>

<style>
  /* Pulsing halo used while this node is the active pipeline step. */
  :global(.node-pulsing) {
    animation: node-pulse 1.6s ease-in-out infinite;
  }
  :global(.node-pulsing::before) {
    content: "";
    position: absolute;
    inset: -4px;
    border-radius: 0.85rem;
    background: radial-gradient(
      circle at center,
      rgb(var(--primary-rgb, 99 102 241) / 0.25),
      transparent 70%
    );
    pointer-events: none;
    z-index: -1;
    animation: node-halo 1.6s ease-in-out infinite;
  }

  /* Drop target: dashed outline + subtle bg shift during drag. */
  :global(.node-drop-target) {
    outline: 2px dashed hsl(var(--primary) / 0.7);
    outline-offset: 2px;
    background: hsl(var(--primary) / 0.06) !important;
  }

  @keyframes node-pulse {
    0%, 100% {
      box-shadow:
        0 0 0 0 hsl(var(--primary) / 0.45),
        0 10px 20px -10px hsl(var(--primary) / 0.2);
    }
    50% {
      box-shadow:
        0 0 0 6px hsl(var(--primary) / 0),
        0 10px 30px -10px hsl(var(--primary) / 0.4);
    }
  }

  @keyframes node-halo {
    0%, 100% { opacity: 0.6; transform: scale(0.98); }
    50%      { opacity: 1;   transform: scale(1.02); }
  }
</style>
