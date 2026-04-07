<script lang="ts">
  import {
    SvelteFlow,
    Background,
    Controls,
    MiniMap,
    Panel,
    BackgroundVariant,
    type NodeTypes,
    type Node,
    type Edge,
  } from "@xyflow/svelte";
  import "@xyflow/svelte/dist/style.css";

  import { createCanvasStore } from "$lib/stores/canvas.svelte";
  import ToolPalette from "./ToolPalette.svelte";
  import DetailPanel from "./DetailPanel.svelte";
  import AgentCoreNode from "./nodes/AgentCoreNode.svelte";
  import ToolNode from "./nodes/ToolNode.svelte";
  import PromptNode from "./nodes/PromptNode.svelte";
  import GuardrailNode from "./nodes/GuardrailNode.svelte";

  import { toast } from "svelte-sonner";
  import { onMount } from "svelte";

  interface Props {
    agentName: string;
  }

  let { agentName }: Props = $props();

  const store = createCanvasStore();

  const nodeTypes: NodeTypes = {
    agentCore: AgentCoreNode as any,
    tool: ToolNode as any,
    prompt: PromptNode as any,
    guardrail: GuardrailNode as any,
  };

  let nodes = $state<Node[]>([]);
  let edges = $state<Edge[]>([]);

  // Rebuild nodes/edges when store state changes
  $effect(() => {
    // Access reactive dependencies
    const _tools = store.tools;
    const _plan = store.plan;
    const _name = store.agentName;
    const _prompt = store.systemPrompt;
    const _budget = store.budgetLimit;
    const _budgetEnabled = store.budgetEnabled;
    const _timeout = store.timeoutSeconds;
    const _model = store.modelOverride;
    const _maxTurns = store.maxTurns;
    const _active = store.isActive;

    nodes = store.buildNodes();
    edges = store.buildEdges();
  });

  // Load agent on mount
  onMount(async () => {
    try {
      await store.loadFromApi(agentName);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load agent");
    }
  });

  // Keyboard shortcut: Cmd/Ctrl+S to save
  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      handleSave();
    }
  }

  async function handleSave() {
    try {
      await store.save();
      toast.success("Agent saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    }
  }

  function handleNodeClick({ node }: { node: Node; event: MouseEvent | TouchEvent }) {
    store.selectedNodeId = node.id;
  }

  function handlePaneClick() {
    store.selectedNodeId = null;
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    const toolId = e.dataTransfer?.getData("application/tool-id");
    if (toolId) {
      store.addTool(toolId);
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="relative h-full w-full" role="application" aria-label="Agent canvas builder">
  {#if store.loading}
    <div class="flex h-full items-center justify-center">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
    </div>
  {:else}
    <!-- Top toolbar -->
    <div class="absolute left-0 right-0 top-0 z-10 flex items-center justify-between border-b border-border bg-card/90 px-4 py-2 backdrop-blur-sm">
      <div class="flex items-center gap-2">
        <a href="/agent/{agentName}/settings" class="text-xs text-muted-foreground hover:text-foreground transition-colors">
          {agentName}
        </a>
        <span class="text-xs text-muted-foreground">/</span>
        <span class="text-xs font-medium text-foreground">Canvas</span>
        {#if store.dirty}
          <span class="ml-2 inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            Unsaved changes
          </span>
        {/if}
      </div>
      <button
        class="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        disabled={store.saving || !store.dirty}
        onclick={handleSave}
      >
        {#if store.saving}
          <span class="h-3 w-3 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>
        {/if}
        Save
      </button>
    </div>

    <!-- Canvas -->
    <div
      class="h-full w-full pt-10"
      ondragover={handleDragOver}
      ondrop={handleDrop}
    >
      <SvelteFlow
        {nodes}
        {edges}
        {nodeTypes}
        fitView
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        onnodeclick={handleNodeClick}
        onpaneclick={handlePaneClick}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls position="bottom-right" />
        <MiniMap position="bottom-left" />

        <Panel position="top-left" class="!mt-12">
          <ToolPalette {store} />
        </Panel>

        {#if store.selectedNodeId}
          <Panel position="top-right" class="!mt-12">
            <DetailPanel {store} />
          </Panel>
        {/if}
      </SvelteFlow>
    </div>
  {/if}
</div>

<style>
  :global(.svelte-flow) {
    --xy-background-color: var(--background);
    --xy-node-border-radius: 0.5rem;
    --xy-edge-stroke: var(--muted-foreground);
    --xy-minimap-background: var(--card);
    --xy-controls-button-background: var(--card);
    --xy-controls-button-color: var(--foreground);
    --xy-controls-button-border-color: var(--border);
  }

  :global(.svelte-flow__minimap) {
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    overflow: hidden;
  }

  :global(.svelte-flow__controls) {
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    overflow: hidden;
  }
</style>
