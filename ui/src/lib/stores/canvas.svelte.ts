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
      name: agentName,
      description,
      is_active: isActive,
      system_prompt: systemPrompt,
      plan,
      model_override: modelOverride || undefined,
      temperature,
      max_tokens: maxTokens,
      reasoning_strategy: reasoningStrategy || undefined,
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

  // ── Hub-and-spoke layout: agent at center, 5 category satellites ──

  // Categorize tools for display
  function categorizeTools(toolIds: string[]): Record<string, string[]> {
    const cats: Record<string, string[]> = {
      "Web & Data": [], "Code & Files": [], "Memory & Knowledge": [],
      "Media": [], "Agents & Automation": [], "Other": [],
    };
    const catMap: Record<string, string> = {
      "web-search": "Web & Data", "browse": "Web & Data", "http-request": "Web & Data", "web-crawl": "Web & Data",
      "python-exec": "Code & Files", "bash": "Code & Files", "read-file": "Code & Files", "write-file": "Code & Files", "edit-file": "Code & Files",
      "memory-save": "Memory & Knowledge", "memory-recall": "Memory & Knowledge", "knowledge-search": "Memory & Knowledge", "store-knowledge": "Memory & Knowledge", "ingest-document": "Memory & Knowledge",
      "image-generate": "Media", "vision-analyze": "Media", "text-to-speech": "Media", "speech-to-text": "Media",
      "create-agent": "Agents & Automation", "run-agent": "Agents & Automation", "list-agents": "Agents & Automation",
      "a2a-send": "Agents & Automation", "marketplace-search": "Agents & Automation",
      "create-schedule": "Agents & Automation", "list-schedules": "Agents & Automation", "delete-schedule": "Agents & Automation",
      "mcp-call": "Agents & Automation",
    };
    for (const id of toolIds) {
      const name = getToolById(id)?.name ?? id;
      const cat = catMap[id] || "Other";
      cats[cat].push(name);
    }
    return cats;
  }

  function buildNodes(): Node[] {
    const nodes: Node[] = [];

    // ── Core agent node at center ──
    nodes.push({
      id: "core",
      type: "agentCore",
      position: { x: 0, y: 0 },
      data: { agentName, plan, modelOverride, budgetLimit: budgetEnabled ? budgetLimit : 0, maxTurns, isActive },
      draggable: true,
    });

    // ── System prompt — above ──
    nodes.push({
      id: "prompt",
      type: "prompt",
      position: { x: 0, y: -220 },
      data: { systemPrompt },
      draggable: true,
    });

    // ── Guardrails — top right ──
    nodes.push({
      id: "guardrail",
      type: "guardrail",
      position: { x: 320, y: -100 },
      data: { budgetEnabled, budgetLimit, timeoutSeconds },
      draggable: true,
    });

    // ── Category satellite nodes — hub and spoke below/around ──
    const toolCats = categorizeTools(tools);
    const activeToolCats = Object.entries(toolCats).filter(([, items]) => items.length > 0);

    // Satellite positions: semicircle below the agent
    const satellites: Array<{ id: string; label: string; icon: string; color: string; accent: string; items: string[]; x: number; y: number }> = [];

    // Fixed category definitions with colors
    const categoryDefs: Record<string, { icon: string; color: string; accent: string }> = {
      "Web & Data": { icon: "M21 21l-5.2-5.2M17 10a7 7 0 11-14 0 7 7 0 0114 0z", color: "bg-blue-500/20 text-blue-400", accent: "border-blue-500/30" },
      "Code & Files": { icon: "M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5", color: "bg-emerald-500/20 text-emerald-400", accent: "border-emerald-500/30" },
      "Memory & Knowledge": { icon: "M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25", color: "bg-purple-500/20 text-purple-400", accent: "border-purple-500/30" },
      "Media": { icon: "M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5z", color: "bg-amber-500/20 text-amber-400", accent: "border-amber-500/30" },
      "Agents & Automation": { icon: "M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197", color: "bg-cyan-500/20 text-cyan-400", accent: "border-cyan-500/30" },
      "Other": { icon: "M11.42 15.17l-5.648-3.177a1.144 1.144 0 01-.002-2.01L11.42 6.83a2.25 2.25 0 012.16 0l5.648 3.177a1.144 1.144 0 01.002 2.01l-5.648 3.177a2.25 2.25 0 01-2.16-.001z", color: "bg-rose-500/20 text-rose-400", accent: "border-rose-500/30" },
    };

    // Position satellites in a row below (spaced evenly)
    const count = activeToolCats.length;
    const spacing = 200;
    const startX = -((count - 1) * spacing) / 2;

    activeToolCats.forEach(([cat, items], i) => {
      const def = categoryDefs[cat] || categoryDefs["Other"];
      satellites.push({
        id: `cat-${cat.toLowerCase().replace(/\s+/g, "-")}`,
        label: cat, icon: def.icon, color: def.color, accent: def.accent,
        items, x: startX + i * spacing, y: 220,
      });
    });

    // Add voice node (left side) — always visible
    nodes.push({
      id: "cat-voice",
      type: "category",
      position: { x: -320, y: -100 },
      data: {
        label: "Voice", count: 0,
        icon: "M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z",
        color: "bg-pink-500/20 text-pink-400", accent: "border-pink-500/30",
        items: ["STT: Whisper V3", "TTS: Kokoro / Chatterbox", "Phone: Twilio"],
      },
      draggable: true,
    });

    // Add category satellite nodes
    for (const sat of satellites) {
      nodes.push({
        id: sat.id,
        type: "category",
        position: { x: sat.x, y: sat.y },
        data: {
          label: sat.label, count: sat.items.length,
          icon: sat.icon, color: sat.color, accent: sat.accent,
          items: sat.items,
        },
        draggable: true,
      });
    }

    return nodes;
  }

  function buildEdges(): Edge[] {
    const edges: Edge[] = [];

    // Prompt → Core
    edges.push({
      id: "edge-prompt-core", source: "prompt", target: "core",
      type: "smoothstep",
      style: "stroke: var(--muted-foreground); stroke-dasharray: 4 4; opacity: 0.5;",
    });

    // Guardrail → Core
    edges.push({
      id: "edge-guardrail-core", source: "guardrail", target: "core",
      type: "smoothstep",
      style: "stroke: var(--destructive); stroke-dasharray: 6 3; opacity: 0.6;",
    });

    // Voice → Core
    edges.push({
      id: "edge-voice-core", source: "cat-voice", target: "core",
      type: "smoothstep",
      style: "stroke: var(--muted-foreground); stroke-dasharray: 4 4; opacity: 0.4;",
    });

    // Category satellites → Core
    const toolCats = categorizeTools(tools);
    for (const [cat, items] of Object.entries(toolCats)) {
      if (items.length === 0) continue;
      const id = `cat-${cat.toLowerCase().replace(/\s+/g, "-")}`;
      edges.push({
        id: `edge-${id}-core`, source: id, target: "core",
        type: "smoothstep",
        style: "stroke: var(--muted-foreground); stroke-dasharray: 4 4; opacity: 0.4;",
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
