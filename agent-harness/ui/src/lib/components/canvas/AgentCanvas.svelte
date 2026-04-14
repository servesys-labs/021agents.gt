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
  import { createTestRunStore } from "$lib/stores/test-run.svelte";
  import { getCurrentDragTool, setCurrentDragTool } from "./drag-context";
  import ToolPalette from "./ToolPalette.svelte";
  import DetailPanel from "./DetailPanel.svelte";
  import PipelineOverlay from "./PipelineOverlay.svelte";
  import TestRunControl from "./TestRunControl.svelte";
  import StepInspector from "./StepInspector.svelte";
  import LiveStatsPanel from "./LiveStatsPanel.svelte";
  import StatusBar from "./StatusBar.svelte";
  import OnboardingTour from "./OnboardingTour.svelte";
  import AgentCoreNode from "./nodes/AgentCoreNode.svelte";
  import ToolNode from "./nodes/ToolNode.svelte";
  import PromptNode from "./nodes/PromptNode.svelte";
  import GuardrailNode from "./nodes/GuardrailNode.svelte";
  import CategoryNode from "./nodes/CategoryNode.svelte";

  import { toast } from "svelte-sonner";
  import { onMount } from "svelte";

  interface Props {
    agentName: string;
  }

  let { agentName }: Props = $props();

  const store = createCanvasStore();
  const runStore = createTestRunStore();

  const nodeTypes: NodeTypes = {
    agentCore: AgentCoreNode as any,
    tool: ToolNode as any,
    prompt: PromptNode as any,
    guardrail: GuardrailNode as any,
    category: CategoryNode as any,
  };

  let nodes = $state<Node[]>([]);
  let edges = $state<Edge[]>([]);

  // Drop-target tracking during tool drag-and-drop. Ephemeral UI state,
  // not persisted to canvas config.
  let dragOverCategoryId = $state<string | null>(null);
  let draggedToolName = $state<string | null>(null);

  /**
   * Map a tool ID to the canvas category node it belongs to. Mirrors the
   * categorization in canvas.svelte.ts but only returns the node ID, so
   * it's cheap to call during dragover.
   */
  function categoryIdForTool(toolId: string): string {
    const catMap: Record<string, string> = {
      "web-search": "web-&-data", "browse": "web-&-data", "http-request": "web-&-data",
      "web-crawl": "web-&-data", "image-generate": "web-&-data", "vision-analyze": "web-&-data",
      "python-exec": "code-&-files", "bash": "code-&-files", "read-file": "code-&-files",
      "write-file": "code-&-files", "edit-file": "code-&-files",
      "memory-save": "memory-&-knowledge", "memory-recall": "memory-&-knowledge",
      "knowledge-search": "memory-&-knowledge", "store-knowledge": "memory-&-knowledge",
      "ingest-document": "memory-&-knowledge",
      "create-agent": "delegation-&-a2a", "run-agent": "delegation-&-a2a",
      "list-agents": "delegation-&-a2a", "a2a-send": "delegation-&-a2a",
      "marketplace-search": "delegation-&-a2a", "share-artifact": "delegation-&-a2a",
      "create-schedule": "delegation-&-a2a", "list-schedules": "delegation-&-a2a",
      "delete-schedule": "delegation-&-a2a", "mcp-call": "delegation-&-a2a",
    };
    return `cat-${catMap[toolId] || "other"}`;
  }

  /**
   * Derive which canvas node IDs should pulse based on the active pipeline
   * step. Governance → rt-governance. LLM → rt-llm-routing + core. Tools →
   * the category containing the active tool call. Result → core. Record →
   * rt-observability. Returns an empty set when idle.
   */
  function computePulsingIds(): Set<string> {
    const ids = new Set<string>();
    if (runStore.status !== "running") return ids;
    const step = runStore.currentStepId;
    if (!step) return ids;

    switch (step) {
      case "setup":
        ids.add("core");
        break;
      case "governance":
        ids.add("rt-governance");
        break;
      case "llm":
        ids.add("rt-llm-routing");
        ids.add("core");
        break;
      case "tools": {
        const toolName = runStore.activeToolName;
        if (toolName) ids.add(categoryIdForTool(toolName));
        break;
      }
      case "result":
        ids.add("core");
        break;
      case "record":
        ids.add("rt-observability");
        break;
    }
    return ids;
  }

  // Rebuild nodes/edges when config state OR runtime overlay state changes.
  $effect(() => {
    // Config state dependencies
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

    // Runtime overlay dependencies
    const _status = runStore.status;
    const _step = runStore.currentStepId;
    const _activeTool = runStore.activeToolName;
    const _dragOver = dragOverCategoryId;
    const _dragTool = draggedToolName;

    const pulsingIds = computePulsingIds();
    const dropTargetIds = new Set<string>();
    if (dragOverCategoryId) dropTargetIds.add(dragOverCategoryId);

    nodes = store.buildNodes({
      pulsingIds,
      dropTargetIds,
      dropPreview: draggedToolName,
    });
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

  // When step inspector opens, close node detail panel (mutual exclusion)
  $effect(() => {
    if (runStore.inspectorStepId) {
      store.selectedNodeId = null;
    }
  });

  // Keyboard shortcuts:
  //   ⌘S       → Save canvas config
  //   ⌘↵       → Open the test-run composer (or submit if already open;
  //              the composer's own onkeydown handler takes over once focused)
  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      handleSave();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      // Don't fire when the composer is already open — its own handler
      // catches ⌘↵ and submits the run.
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "TEXTAREA" || target?.tagName === "INPUT") return;
      e.preventDefault();
      if (!runStore.composing && runStore.status !== "running") {
        runStore.openComposer();
      }
      return;
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
    // Opening a node detail closes the step inspector
    runStore.closeInspector();
  }

  function handlePaneClick() {
    store.selectedNodeId = null;
    runStore.closeInspector();
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    // Seed the drop-target preview on the first dragover event of a drag.
    // We can't read the dragged payload during dragover (browser security),
    // so the ToolPalette stashes the current drag into a module-level ref
    // that we read here (see setCurrentDrag() below).
    if (!draggedToolName) {
      const current = getCurrentDragTool();
      if (current) {
        draggedToolName = current.name;
        dragOverCategoryId = categoryIdForTool(current.id);
      }
    }
  }

  function handleDragLeave(e: DragEvent) {
    // Only clear when the drag leaves the canvas entirely (not when it
    // passes over a child node). `relatedTarget` is null when leaving the
    // window or document root. Cast to globalThis.Node to avoid collision
    // with the @xyflow/svelte `Node` type imported above.
    const current = e.currentTarget as unknown as globalThis.Node;
    const related = e.relatedTarget as unknown as globalThis.Node | null;
    if (!related || !current.contains(related)) {
      dragOverCategoryId = null;
      draggedToolName = null;
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    const toolId = e.dataTransfer?.getData("application/tool-id");
    if (toolId) {
      store.addTool(toolId);
    }
    dragOverCategoryId = null;
    draggedToolName = null;
    setCurrentDragTool(null);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="relative h-full w-full" role="application" aria-label="Agent canvas builder">
  {#if store.loading}
    <!-- Skeleton canvas — placeholder cards in approximate positions. Shows
         the user where things will land instead of a generic spinner. -->
    <div class="relative h-full w-full overflow-hidden p-8">
      <div class="skeleton-bg pointer-events-none absolute inset-0 opacity-30"></div>
      <div class="relative grid h-full w-full place-items-center">
        <div class="grid grid-cols-3 gap-6" style="width: 760px;">
          <div class="skeleton-card h-16"></div>
          <div class="skeleton-card h-20"></div>
          <div class="skeleton-card h-16"></div>
          <div class="skeleton-card h-20"></div>
          <div class="skeleton-card h-32" style="background: hsl(var(--card)); border: 2px solid hsl(var(--primary) / 0.3); box-shadow: 0 0 40px -10px hsl(var(--primary) / 0.25);"></div>
          <div class="skeleton-card h-20"></div>
          <div class="skeleton-card h-16"></div>
          <div class="skeleton-card h-16"></div>
          <div class="skeleton-card h-16"></div>
        </div>
      </div>
      <div class="absolute bottom-6 left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground/60">
        loading agent…
      </div>
    </div>
  {:else}
    <!-- Top toolbar -->
    <div class="absolute left-0 right-0 top-0 z-20 flex items-center justify-between border-b border-border bg-card/90 px-4 py-2 backdrop-blur-sm">
      <div class="flex items-center gap-2">
        <a href="/agent/{agentName}/settings" class="text-xs text-muted-foreground hover:text-foreground transition-colors">
          {agentName}
        </a>
        <span class="text-xs text-muted-foreground">/</span>
        <span class="text-xs font-medium text-foreground">Canvas</span>
      </div>
      <div class="flex items-center gap-2">
        <TestRunControl {runStore} canvasStore={store} />
        <button
          class="inline-flex items-center justify-center rounded-md border border-border bg-card p-1.5 text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          disabled={store.saving || !store.dirty}
          onclick={handleSave}
          title="Save (⌘S)"
          aria-label="Save"
        >
          {#if store.saving}
            <span class="h-3 w-3 animate-spin rounded-full border-2 border-foreground border-t-transparent"></span>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          {/if}
        </button>
      </div>
    </div>

    <!-- Pipeline overlay — fixed band under the toolbar -->
    <div class="pointer-events-none absolute left-1/2 top-12 z-10 -translate-x-1/2">
      <PipelineOverlay {runStore} />
    </div>

    <!-- Canvas pane: SvelteFlow + bottom StatusBar share the space below
         the top toolbar. Flex column so StatusBar always sits at bottom. -->
    <div class="flex h-full w-full flex-col pt-10">
      <div
        class="relative min-h-0 flex-1"
        role="region"
        aria-label="Canvas drop area"
        ondragover={handleDragOver}
        ondragleave={handleDragLeave}
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
          proOptions={{ hideAttribution: true }}
          onnodeclick={handleNodeClick}
          onpaneclick={handlePaneClick}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <!-- Both navigation aids in bottom-left so the bottom-right is
               reserved exclusively for LiveStatsPanel (no overlap). -->
          <Controls position="bottom-left" />
          <MiniMap position="bottom-left" />

          <Panel position="top-left" class="!mt-12">
            <ToolPalette {store} />
          </Panel>

          <!-- Right-side inspector: StepInspector wins if both are open -->
          {#if runStore.inspectorStepId}
            <Panel position="top-right" class="!mt-32">
              <StepInspector {runStore} canvasStore={store} />
            </Panel>
          {:else if store.selectedNodeId}
            <Panel position="top-right" class="!mt-32">
              <DetailPanel {store} />
            </Panel>
          {/if}

          <Panel position="bottom-right" class="!mb-2 !mr-2">
            <LiveStatsPanel {runStore} canvasStore={store} />
          </Panel>
        </SvelteFlow>
      </div>
      <StatusBar {runStore} canvasStore={store} />
    </div>
    <OnboardingTour />
  {/if}
</div>

<style>
  :global(.svelte-flow) {
    --xy-background-color: var(--background);
    --xy-node-border-radius: 0.5rem;
    --xy-edge-stroke: var(--muted-foreground);
    --xy-minimap-background: var(--card);
    --xy-minimap-mask-background: hsl(var(--background) / 0.7);
    --xy-minimap-node-background: hsl(var(--muted-foreground));
    --xy-controls-button-background: var(--card);
    --xy-controls-button-background-hover: var(--muted);
    --xy-controls-button-color: var(--foreground);
    --xy-controls-button-color-hover: var(--foreground);
    --xy-controls-button-border-color: var(--border);
  }

  :global(.svelte-flow__minimap) {
    background: var(--card) !important;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    overflow: hidden;
  }

  :global(.svelte-flow__minimap svg) {
    background: var(--card) !important;
  }

  :global(.svelte-flow__minimap-mask) {
    fill: hsl(0 0% 0% / 0.3) !important;
  }

  :global(.svelte-flow__minimap-node) {
    fill: var(--muted-foreground) !important;
  }

  :global(.svelte-flow__controls) {
    background: var(--card) !important;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    overflow: hidden;
  }

  :global(.svelte-flow__controls button) {
    background: var(--card) !important;
    color: var(--foreground) !important;
    border-color: var(--border) !important;
  }

  :global(.svelte-flow__controls button:hover) {
    background: var(--muted) !important;
  }

  :global(.svelte-flow__controls button svg) {
    fill: var(--foreground) !important;
  }

  :global(.svelte-flow__attribution) {
    display: none !important;
  }

  :global(.svelte-flow__panel.attribution) {
    display: none !important;
  }

  /* Skeleton loader — faded cards in approximate canvas positions */
  .skeleton-card {
    background: hsl(var(--muted) / 0.5);
    border: 1px solid hsl(var(--border) / 0.6);
    border-radius: 0.75rem;
    animation: skeleton-pulse 1.6s ease-in-out infinite;
  }
  .skeleton-bg {
    background-image:
      radial-gradient(circle, hsl(var(--muted-foreground) / 0.15) 1px, transparent 1px);
    background-size: 20px 20px;
  }
  @keyframes skeleton-pulse {
    0%, 100% { opacity: 0.5; }
    50%      { opacity: 0.8; }
  }
</style>
