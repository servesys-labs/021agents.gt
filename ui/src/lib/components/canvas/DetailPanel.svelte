<script lang="ts">
  import type { CanvasStore } from "$lib/stores/canvas.svelte";
  import CoreDetailPanel from "./panels/CoreDetailPanel.svelte";
  import PromptDetailPanel from "./panels/PromptDetailPanel.svelte";
  import GuardrailDetailPanel from "./panels/GuardrailDetailPanel.svelte";
  import { getToolById } from "$lib/data/tools";

  interface Props {
    store: CanvasStore;
  }

  let { store }: Props = $props();

  let nodeId = $derived(store.selectedNodeId);

  let panelType = $derived<"core" | "prompt" | "guardrail" | "tool" | null>(
    nodeId === "core"
      ? "core"
      : nodeId === "prompt"
        ? "prompt"
        : nodeId === "guardrail"
          ? "guardrail"
          : nodeId?.startsWith("tool-")
            ? "tool"
            : null
  );

  let selectedToolId = $derived(
    nodeId?.startsWith("tool-") ? nodeId.replace("tool-", "") : null
  );

  let selectedTool = $derived(selectedToolId ? getToolById(selectedToolId) : null);
</script>

<div
  class="flex flex-col rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur-sm"
  style="width: 320px; max-height: calc(100vh - 8rem);"
>
  <div class="flex items-center justify-between border-b border-border p-3">
    <p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {#if panelType === "core"}Agent Config
      {:else if panelType === "prompt"}Prompt
      {:else if panelType === "guardrail"}Guardrails
      {:else if panelType === "tool"}Tool
      {:else}Details
      {/if}
    </p>
    <button
      class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      onclick={() => (store.selectedNodeId = null)}
      aria-label="Close panel"
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>

  <div class="flex-1 overflow-y-auto p-4">
    {#if panelType === "core"}
      <CoreDetailPanel {store} />
    {:else if panelType === "prompt"}
      <PromptDetailPanel {store} />
    {:else if panelType === "guardrail"}
      <GuardrailDetailPanel {store} />
    {:else if panelType === "tool" && selectedTool}
      <div class="space-y-4">
        <div class="flex items-center gap-3">
          <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d={selectedTool.icon} />
            </svg>
          </div>
          <div>
            <h3 class="text-sm font-semibold text-foreground">{selectedTool.name}</h3>
            <p class="text-xs text-muted-foreground">{selectedTool.description}</p>
          </div>
        </div>

        <div class="rounded-md bg-muted p-3">
          <p class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Category</p>
          <p class="text-xs text-foreground capitalize">{selectedTool.category}</p>
        </div>

        <button
          class="w-full rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
          onclick={() => {
            if (selectedToolId) store.removeTool(selectedToolId);
          }}
        >
          Remove Tool
        </button>
      </div>
    {/if}
  </div>
</div>
