<script lang="ts">
  import { TOOL_CATEGORIES, AVAILABLE_TOOLS, type ToolDef } from "$lib/data/tools";
  import type { CanvasStore } from "$lib/stores/canvas.svelte";
  import { setCurrentDragTool } from "./drag-context";

  interface Props {
    store: CanvasStore;
  }

  let { store }: Props = $props();
  let search = $state("");
  // Sections collapsed by default — keeps the sidebar scannable. Expand
  // automatically when the user types in search so they see results.
  let collapsedSections = $state<Set<string>>(new Set(["code", "memory", "media"]));

  // Whole-panel collapse state. Persists in localStorage so the user's
  // preference survives reloads. Default to expanded on first visit.
  let collapsed = $state(false);
  const STORAGE_KEY = "oneshots_canvas_palette_collapsed";

  $effect(() => {
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem(STORAGE_KEY) === "1") collapsed = true;
  });

  function togglePanel() {
    collapsed = !collapsed;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    }
  }

  // Total enabled tool count, shown as a single number on the collapsed rail.
  let totalEnabled = $derived(store.tools.length);

  function toggleSection(id: string) {
    const next = new Set(collapsedSections);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsedSections = next;
  }

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

  function enabledCountInCategory(category: string): number {
    return AVAILABLE_TOOLS.filter(
      (t) => t.category === category && store.tools.includes(t.id),
    ).length;
  }

  // Override collapse state when searching — show all matching results
  function isExpanded(catId: string): boolean {
    if (search.trim()) return true;
    return !collapsedSections.has(catId);
  }

  function handleDragStart(e: DragEvent, tool: ToolDef) {
    if (e.dataTransfer) {
      e.dataTransfer.setData("application/tool-id", tool.id);
      e.dataTransfer.effectAllowed = "move";
    }
    // Stash the dragged tool so the canvas can read it on dragover and
    // show a drop-target preview. Cleared on drop/dragend.
    setCurrentDragTool({ id: tool.id, name: tool.name });
  }

  function handleDragEnd() {
    setCurrentDragTool(null);
  }
</script>

{#if collapsed}
  <!-- Collapsed rail — single click expands the panel back -->
  <button
    type="button"
    class="flex flex-col items-center gap-2 rounded-lg border border-border bg-card/95 px-2 py-3 shadow-lg backdrop-blur-sm transition-colors hover:bg-accent"
    onclick={togglePanel}
    title="Expand tools"
    aria-label="Expand tool palette"
  >
    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M11.42 15.17l-5.648-3.177a1.144 1.144 0 01-.002-2.01L11.42 6.83a2.25 2.25 0 012.16 0l5.648 3.177a1.144 1.144 0 01.002 2.01l-5.648 3.177a2.25 2.25 0 01-2.16-.001z" />
    </svg>
    {#if totalEnabled > 0}
      <span class="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-mono text-emerald-400">
        {totalEnabled}
      </span>
    {/if}
    <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  </button>
{:else}
<div
  class="flex flex-col rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur-sm"
  style="width: 220px; max-height: min(480px, calc(100vh - 12rem));"
>
  <div class="border-b border-border p-3">
    <div class="mb-2 flex items-center justify-between">
      <p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tools</p>
      <button
        type="button"
        class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        onclick={togglePanel}
        title="Collapse"
        aria-label="Collapse tool palette"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
    </div>
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
    {#each TOOL_CATEGORIES as category (category.id)}
      {@const catTools = toolsByCategory(category.id)}
      {@const enabledCount = enabledCountInCategory(category.id)}
      {@const expanded = isExpanded(category.id)}
      {#if catTools.length > 0}
        <div class="mb-2">
          <button
            type="button"
            class="mb-1 flex w-full items-center gap-1 px-1 text-left transition-colors hover:text-foreground"
            onclick={() => toggleSection(category.id)}
            aria-expanded={expanded}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-2.5 w-2.5 text-muted-foreground transition-transform duration-150"
              class:rotate-90={expanded}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              stroke-width="3"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <span class="text-[10px] font-semibold uppercase tracking-wider {category.accent}">
              {category.label}
            </span>
            {#if enabledCount > 0}
              <span class="ml-auto rounded-full bg-emerald-500/20 px-1.5 text-[9px] font-mono text-emerald-400">
                {enabledCount}
              </span>
            {/if}
          </button>
          {#if expanded}
          {#each catTools as tool}
            {@const isEnabled = store.tools.includes(tool.id)}
            <button
              class="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50
                {isEnabled ? 'opacity-50' : ''}"
              draggable="true"
              ondragstart={(e) => handleDragStart(e, tool)}
              ondragend={handleDragEnd}
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
          {/if}
        </div>
      {/if}
    {/each}
  </div>
</div>
{/if}
