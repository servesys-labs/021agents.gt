import { api } from "$lib/services/api";
import { agentStore } from "$lib/stores/agents.svelte";
import type { Node, Edge } from "@xyflow/svelte";
import { AVAILABLE_TOOLS, getToolById } from "$lib/data/tools";

export function createCanvasStore() {
  // Agent config state (mirrors settings page)
  let agentName = $state("");
  let description = $state("");
  let systemPrompt = $state("You are a helpful AI assistant.");
  let plan = $state("standard");
  let modelOverride = $state("");
  let temperature = $state(0.7);
  let maxTokens = $state(4096);
  let reasoningStrategy = $state("auto");
  let maxTurns = $state(15);
  let tools = $state<string[]>([]);
  let budgetLimit = $state(5);
  let budgetEnabled = $state(false);
  let timeoutSeconds = $state(300);
  let isActive = $state(true);
  let delegates = $state<string[]>([]);
  let handoffConfig = $state<Record<string, unknown>>({ enabled: false });

  // Canvas UI state
  let dirty = $state(false);
  let saving = $state(false);
  let loading = $state(true);
  let selectedNodeId = $state<string | null>(null);

  function markDirty() {
    dirty = true;
  }

  function addTool(toolId: string) {
    if (!tools.includes(toolId) && AVAILABLE_TOOLS.some((t) => t.id === toolId)) {
      tools = [...tools, toolId];
      markDirty();
    }
  }

  function removeTool(toolId: string) {
    tools = tools.filter((t) => t !== toolId);
    if (selectedNodeId === `tool-${toolId}`) {
      selectedNodeId = null;
    }
    markDirty();
  }

  function toggleTool(toolId: string) {
    if (tools.includes(toolId)) {
      removeTool(toolId);
    } else {
      addTool(toolId);
    }
  }

  /** Produce the EXACT same API payload as settings page handleSave() */
  function toApiPayload(): Record<string, unknown> {
    return {
      description,
      is_active: isActive,
      system_prompt: systemPrompt,
      plan,
      model_override: modelOverride || undefined,
      temperature,
      max_tokens: maxTokens,
      reasoning_strategy: reasoningStrategy,
      max_turns: maxTurns,
      tools,
      budget_limit_usd: budgetEnabled ? budgetLimit : 0,
      timeout_seconds: timeoutSeconds,
      handoff_config: handoffConfig,
    };
  }

  async function loadFromApi(name: string) {
    loading = true;
    agentName = name;
    try {
      const data = await api.getAgentDetail(name);
      const a = ((data as any).agent ?? data) as Record<string, any>;
      description = a.description ?? "";
      isActive = a.is_active ?? true;
      systemPrompt = a.system_prompt ?? a.config_json?.system_prompt ?? "";
      plan = a.plan ?? "standard";
      modelOverride = a.model_override ?? a.config_json?.model_override ?? "";
      temperature = a.temperature ?? a.config_json?.temperature ?? 0.7;
      maxTokens = a.max_tokens ?? a.config_json?.max_tokens ?? 4096;
      reasoningStrategy = a.reasoning_strategy ?? a.config_json?.reasoning_strategy ?? "auto";
      maxTurns = a.max_turns ?? a.config_json?.max_turns ?? 15;
      tools = a.tools ?? [];
      const rawBudget = a.budget_limit_usd ?? a.budget_limit ?? a.config_json?.budget_limit;
      budgetEnabled = rawBudget != null && rawBudget > 0 && rawBudget < 999;
      budgetLimit = rawBudget ?? 5;
      timeoutSeconds = a.timeout_seconds ?? a.config_json?.timeout_seconds ?? 300;
      const hc = a.handoff_config ?? a.config_json?.handoff_config;
      if (hc) {
        handoffConfig = hc;
      }
      dirty = false;
    } catch (err) {
      throw err;
    } finally {
      loading = false;
    }
  }

  async function save(): Promise<boolean> {
    saving = true;
    try {
      await api.updateAgent(agentName, toApiPayload());
      await agentStore.fetchAgents();
      dirty = false;
      return true;
    } catch (err) {
      throw err;
    } finally {
      saving = false;
    }
  }

  // --- Layout helpers ---

  function computeToolPositions(toolIds: string[]): Array<{ id: string; x: number; y: number }> {
    const n = toolIds.length;
    if (n === 0) return [];
    const radius = 280;
    const startAngle = -60 * (Math.PI / 180);
    const endAngle = 60 * (Math.PI / 180);
    const angleStep = n === 1 ? 0 : (endAngle - startAngle) / (n - 1);

    return toolIds.map((id, i) => {
      const angle = n === 1 ? 0 : startAngle + angleStep * i;
      return {
        id,
        x: radius * Math.sin(angle),
        y: radius * Math.cos(angle) + 200,
      };
    });
  }

  function buildNodes(): Node[] {
    const nodes: Node[] = [];

    // Core agent node at center
    nodes.push({
      id: "core",
      type: "agentCore",
      position: { x: 0, y: 0 },
      data: {
        agentName,
        plan,
        modelOverride,
        budgetLimit: budgetEnabled ? budgetLimit : 0,
        maxTurns,
        isActive,
      },
      draggable: true,
    });

    // Prompt node above
    nodes.push({
      id: "prompt",
      type: "prompt",
      position: { x: 0, y: -250 },
      data: {
        systemPrompt,
      },
      draggable: true,
    });

    // Guardrail node to the right
    nodes.push({
      id: "guardrail",
      type: "guardrail",
      position: { x: 350, y: 0 },
      data: {
        budgetEnabled,
        budgetLimit,
        timeoutSeconds,
      },
      draggable: true,
    });

    // Tool nodes in semicircle below
    const toolPositions = computeToolPositions(tools);
    for (const tp of toolPositions) {
      const toolDef = getToolById(tp.id);
      nodes.push({
        id: `tool-${tp.id}`,
        type: "tool",
        position: { x: tp.x, y: tp.y },
        data: {
          toolId: tp.id,
          name: toolDef?.name ?? tp.id,
          description: toolDef?.description ?? "",
          icon: toolDef?.icon ?? "",
        },
        draggable: true,
      });
    }

    return nodes;
  }

  function buildEdges(): Edge[] {
    const edges: Edge[] = [];

    // Prompt -> Core
    edges.push({
      id: "edge-prompt-core",
      source: "prompt",
      target: "core",
      type: "smoothstep",
      style: "stroke: var(--muted-foreground); stroke-dasharray: 4 4; opacity: 0.5;",
      animated: false,
    });

    // Guardrail -> Core
    edges.push({
      id: "edge-guardrail-core",
      source: "guardrail",
      target: "core",
      type: "smoothstep",
      style: "stroke: var(--destructive); stroke-dasharray: 6 3; opacity: 0.6;",
      animated: false,
    });

    // Tool -> Core
    for (const toolId of tools) {
      edges.push({
        id: `edge-tool-${toolId}`,
        source: `tool-${toolId}`,
        target: "core",
        type: "smoothstep",
        style: "stroke: var(--muted-foreground); stroke-dasharray: 4 4; opacity: 0.4;",
        animated: false,
      });
    }

    return edges;
  }

  return {
    // State getters/setters
    get agentName() { return agentName; },
    set agentName(v: string) { agentName = v; },
    get description() { return description; },
    set description(v: string) { description = v; markDirty(); },
    get systemPrompt() { return systemPrompt; },
    set systemPrompt(v: string) { systemPrompt = v; markDirty(); },
    get plan() { return plan; },
    set plan(v: string) { plan = v; markDirty(); },
    get modelOverride() { return modelOverride; },
    set modelOverride(v: string) { modelOverride = v; markDirty(); },
    get temperature() { return temperature; },
    set temperature(v: number) { temperature = v; markDirty(); },
    get maxTokens() { return maxTokens; },
    set maxTokens(v: number) { maxTokens = v; markDirty(); },
    get reasoningStrategy() { return reasoningStrategy; },
    set reasoningStrategy(v: string) { reasoningStrategy = v; markDirty(); },
    get maxTurns() { return maxTurns; },
    set maxTurns(v: number) { maxTurns = v; markDirty(); },
    get tools() { return tools; },
    get budgetLimit() { return budgetLimit; },
    set budgetLimit(v: number) { budgetLimit = v; markDirty(); },
    get budgetEnabled() { return budgetEnabled; },
    set budgetEnabled(v: boolean) { budgetEnabled = v; markDirty(); },
    get timeoutSeconds() { return timeoutSeconds; },
    set timeoutSeconds(v: number) { timeoutSeconds = v; markDirty(); },
    get isActive() { return isActive; },
    set isActive(v: boolean) { isActive = v; markDirty(); },
    get delegates() { return delegates; },
    get dirty() { return dirty; },
    get saving() { return saving; },
    get loading() { return loading; },
    get selectedNodeId() { return selectedNodeId; },
    set selectedNodeId(v: string | null) { selectedNodeId = v; },

    // Methods
    addTool,
    removeTool,
    toggleTool,
    toApiPayload,
    loadFromApi,
    save,
    buildNodes,
    buildEdges,
    markDirty,
  };
}

export type CanvasStore = ReturnType<typeof createCanvasStore>;
