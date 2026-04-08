<script lang="ts">
  import { TOOL_CATEGORIES, AVAILABLE_TOOLS, type ToolDef } from "$lib/data/tools";
  import type { CanvasStore } from "$lib/stores/canvas.svelte";

  interface Props {
    store: CanvasStore;
  }

  let { store }: Props = $props();
  let search = $state("");

  let filteredTools = $derived(
    search.trim()
      ? AVAILABLE_TOOLS.filter(
          (t) =>
            t.name.toLowerCase().includes(search.toLowerCase()) ||
            t.description.toLowerCase().includes(search.toLowerCase())
        )
      : AVAILABLE_TOOLS
  );

  function toolsByCategory(category: string): ToolDef[] {
    return filteredTools.filter((t) => t.category === category);
  }

  function handleDragStart(e: DragEvent, tool: ToolDef) {
    if (e.dataTransfer) {
      e.dataTransfer.setData("application/tool-id", tool.id);
      e.dataTransfer.effectAllowed = "move";
    }
  }
</script>

<div
  class="flex flex-col rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur-sm"
  style="width: 220px; max-height: min(480px, calc(100vh - 12rem));"
>
  <div class="border-b border-border p-3">
    <p class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tools</p>
    <div class="relative">
      <svg xmlns="http://www.w3.org/2000/svg" class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.2-5.2M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      <input
        type="text"
        placeholder="Search tools..."
        class="w-full rounded-md border border-input bg-background py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        bind:value={search}
      />
    </div>
  </div>

  <div class="flex-1 overflow-y-auto p-2">
    {#each TOOL_CATEGORIES as category}
      {@const catTools = toolsByCategory(category.id)}
      {#if catTools.length > 0}
        <div class="mb-3">
          <p class="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider {category.accent}">
            {category.label}
          </p>
          {#each catTools as tool}
            {@const isEnabled = store.tools.includes(tool.id)}
            <button
              class="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50
                {isEnabled ? 'opacity-50' : ''}"
              draggable="true"
              ondragstart={(e) => handleDragStart(e, tool)}
              onclick={() => store.toggleTool(tool.id)}
            >
              <div class="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d={tool.icon} />
                </svg>
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-medium text-foreground">{tool.name}</p>
                <p class="truncate text-[10px] text-muted-foreground">{tool.description}</p>
              </div>
              {#if isEnabled}
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 shrink-0 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              {:else}
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
                </svg>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    {/each}
  </div>
</div>
