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

  // Categorize tools for display. Media folded into Web & Data.
  // Agents & Automation renamed → Delegation & A2A.
  function categorizeTools(toolIds: string[]): Record<string, string[]> {
    const cats: Record<string, string[]> = {
      "Web & Data": [], "Code & Files": [], "Memory & Knowledge": [],
      "Delegation & A2A": [], "Other": [],
    };
    const catMap: Record<string, string> = {
      "web-search": "Web & Data", "browse": "Web & Data", "http-request": "Web & Data", "web-crawl": "Web & Data",
      "image-generate": "Web & Data", "vision-analyze": "Web & Data",
      "python-exec": "Code & Files", "bash": "Code & Files", "read-file": "Code & Files", "write-file": "Code & Files", "edit-file": "Code & Files",
      "memory-save": "Memory & Knowledge", "memory-recall": "Memory & Knowledge", "knowledge-search": "Memory & Knowledge", "store-knowledge": "Memory & Knowledge", "ingest-document": "Memory & Knowledge",
      "create-agent": "Delegation & A2A", "run-agent": "Delegation & A2A", "list-agents": "Delegation & A2A",
      "a2a-send": "Delegation & A2A", "marketplace-search": "Delegation & A2A", "share-artifact": "Delegation & A2A",
      "create-schedule": "Delegation & A2A", "list-schedules": "Delegation & A2A", "delete-schedule": "Delegation & A2A",
      "mcp-call": "Delegation & A2A",
    };
    for (const id of toolIds) {
      const name = getToolById(id)?.name ?? id;
      const cat = catMap[id] || "Other";
      cats[cat].push(name);
    }
    return cats;
  }

  // ── Icon paths (lucide-style single-path SVGs) ──
  const ICONS = {
    search: "M21 21l-5.2-5.2M17 10a7 7 0 11-14 0 7 7 0 0114 0z",
    code: "M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5",
    book: "M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25",
    users: "M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197",
    cube: "M11.42 15.17l-5.648-3.177a1.144 1.144 0 01-.002-2.01L11.42 6.83a2.25 2.25 0 012.16 0l5.648 3.177a1.144 1.144 0 01.002 2.01l-5.648 3.177a2.25 2.25 0 01-2.16-.001z",
    mic: "M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z",
    shield: "M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z",
    route: "M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5",
    braces: "M7.5 8.25v-.75a2.25 2.25 0 012.25-2.25h.75m-3 11.25v.75a2.25 2.25 0 002.25 2.25h.75m6-14.25h.75a2.25 2.25 0 012.25 2.25v.75m-3 11.25h.75a2.25 2.25 0 002.25-2.25v-.75",
    sparkles: "M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z",
    flask: "M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5",
    activity: "M3.75 3v11.25A2.25 2.25 0 006 16.5h12M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5",
    send: "M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5",
    globe: "M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418",
    mail: "M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75",
  };

  // ── Three-tier semantic color system ──
  // Reduces visual noise by using one color per *role*, not per node:
  //   primitives → indigo  (governance, llm-routing, codemode — runtime layer)
  //   capabilities → emerald (web, code, memory, a2a, skills — what the agent can DO)
  //   sinks → slate         (evals, observability — passive collectors)
  // The accent border is dropped — color now lives only in the icon chip
  // and an optional left-border, which is plenty of color cue.
  const TIER_COLORS = {
    primitive: { color: "bg-indigo-500/15 text-indigo-300", accent: "border-border" },
    capability: { color: "bg-emerald-500/15 text-emerald-300", accent: "border-border" },
    sink: { color: "bg-slate-500/15 text-slate-300", accent: "border-border" },
  };

  // Category visual definitions used by capability satellites
  const categoryDefs: Record<string, { icon: string; color: string; accent: string }> = {
    "Web & Data": { icon: ICONS.search, ...TIER_COLORS.capability },
    "Code & Files": { icon: ICONS.code, ...TIER_COLORS.capability },
    "Memory & Knowledge": { icon: ICONS.book, ...TIER_COLORS.capability },
    "Delegation & A2A": { icon: ICONS.users, ...TIER_COLORS.capability },
    "Other": { icon: ICONS.cube, ...TIER_COLORS.capability },
  };

  // Runtime group (Governance / LLM & Routing / Codemode / Skills / Evals / Observability)
  // These reflect the real harness, not just user-picked tools
  interface RuntimeGroup {
    id: string;
    label: string;
    subtitle: string;
    /** One-line explanation surfaced on hover via the node title attribute. */
    tooltip: string;
    icon: string;
    color: string;
    accent: string;
    items: string[];
  }
  function buildRuntimeGroups(): RuntimeGroup[] {
    return [
      {
        id: "governance",
        label: "Governance",
        subtitle: "Guards · budgets · breakers",
        tooltip:
          "Pre-LLM validators that gate every turn: budget caps, rate limits, " +
          "circuit breakers, PII redaction, SSRF blocks, and tool allowlist. " +
          "If anything fails here, the LLM call doesn't happen.",
        icon: ICONS.shield,
        ...TIER_COLORS.primitive,
        items: [
          budgetEnabled ? `Budget $${budgetLimit}` : "Budget off",
          `Timeout ${Math.round(timeoutSeconds / 60)}m`,
          `Max turns ${maxTurns}`,
          "Rate limit · per session",
          "Circuit breaker · DB",
        ],
      },
      {
        id: "llm-routing",
        label: "LLM & Routing",
        subtitle: "Model tier · category · cache",
        tooltip:
          "Picks which model handles each turn based on plan, query category, " +
          "and tool requirements. Routes through CF AI Gateway with prompt " +
          "caching and 300s response cache.",
        icon: ICONS.route,
        ...TIER_COLORS.primitive,
        items: [
          `Plan · ${plan}`,
          modelOverride ? `Override · ${modelOverride}` : "Route · plan default",
          `Temp ${temperature}`,
          "AI Gateway cache · 300s",
          "Prompt caching · on",
        ],
      },
      {
        id: "codemode",
        label: "Codemode",
        subtitle: "10 scopes · sandboxed V8",
        tooltip:
          "Sandboxed V8 execution across 10 permission scopes. Lets you ship " +
          "graph nodes, transforms, validators, webhook handlers, and " +
          "middleware as code without redeploying the runtime.",
        icon: ICONS.braces,
        ...TIER_COLORS.primitive,
        items: [
          "graph_node",
          "transform",
          "validator",
          "webhook",
          "middleware",
          "+5 more",
        ],
      },
      {
        id: "skills",
        label: "Skills",
        subtitle: "Installed · auto-delegation",
        tooltip:
          "Skills are agents you can delegate to via the marketplace. The " +
          "personal assistant auto-routes complex skill requests to specialist " +
          "agents using A2A + x-402 payment.",
        icon: ICONS.sparkles,
        ...TIER_COLORS.capability,
        items: [
          "/research",
          "/report",
          "/chart",
          "/pdf",
          "/analyze",
        ],
      },
      {
        id: "evals",
        label: "Evals",
        subtitle: "Test cases · pass rate",
        tooltip:
          "Test cases attached to this agent. Each eval run records pass/fail, " +
          "latency, and cost so regressions are visible across deploys.",
        icon: ICONS.flask,
        ...TIER_COLORS.sink,
        items: [
          "No evals attached",
          "Add a test case →",
        ],
      },
      {
        id: "observability",
        label: "Observability",
        subtitle: "Traces · billing · telemetry",
        tooltip:
          "Passive sink for everything the runtime emits: billing_records, " +
          "sessions, turns, events queue, telemetry queue, and the structured " +
          "logger. This is where cost and performance data lives.",
        icon: ICONS.activity,
        ...TIER_COLORS.sink,
        items: [
          "billing_records",
          "sessions",
          "turns",
          "events queue",
          "telemetry queue",
        ],
      },
    ];
  }

  interface ChannelDef {
    id: string; label: string; icon: string; enabled: boolean;
  }
  function buildChannels(): ChannelDef[] {
    return [
      { id: "voice", label: "Voice", icon: ICONS.mic, enabled: false },
      { id: "telegram", label: "Telegram", icon: ICONS.send, enabled: false },
      { id: "web", label: "Web", icon: ICONS.globe, enabled: true },
      { id: "email", label: "Email", icon: ICONS.mail, enabled: false },
    ];
  }

  /**
   * Overlay state injected into nodes at build time. Keeps runtime-only
   * concerns (active pipeline step, drag-and-drop preview) out of the main
   * canvas config state so saves/loads aren't polluted.
   */
  interface NodeOverlay {
    /** Node IDs that should show a pulsing halo (active pipeline step). */
    pulsingIds?: Set<string>;
    /** Node IDs that should highlight as a drop target during tool drag. */
    dropTargetIds?: Set<string>;
    /** Tool name shown in the floating drop-target pill. */
    dropPreview?: string | null;
  }

  function buildNodes(overlay: NodeOverlay = {}): Node[] {
    const nodes: Node[] = [];
    const pulsingIds = overlay.pulsingIds ?? new Set<string>();
    const dropTargetIds = overlay.dropTargetIds ?? new Set<string>();
    const dropPreview = overlay.dropPreview ?? null;

    // ── Layout constants ──────────────────────────────────────────
    // The canvas is laid out as four strict horizontal tiers. Each tier
    // has consistent vertical spacing so connecting edges (orthogonal step
    // edges, see buildEdges) form clean right-angle lines on first paint.
    //
    //   y = -300  TIER 1  Governance ── Prompt ── LLM Routing
    //   y =    0  TIER 2  Core
    //   y =  240  TIER 3  Codemode ── (capability satellites) ── Skills
    //   y =  480  TIER 4  Evals ── Observability  (centered under core)
    //
    // Horizontal positions on tier 1 are mirrored: prompt at x=0, two
    // runtime cards at ±300. Tier 3 expands with the number of tool
    // categories so codemode/skills always sit 220px outside the
    // leftmost/rightmost capability. Tier 4 is always centered.
    const TIER1_Y = -300;
    const TIER2_Y = 0;
    const TIER3_Y = 240;
    const TIER4_Y = 480;
    const TIER1_X = 300;        // governance / llm-routing offset from prompt
    const TIER3_SPACING = 220;  // horizontal gap between tier 3 nodes
    const TIER4_OFFSET = 140;   // evals / observability offset from center

    const runtimeGroups = buildRuntimeGroups();
    const governance = runtimeGroups.find((g) => g.id === "governance")!;
    const llmRouting = runtimeGroups.find((g) => g.id === "llm-routing")!;
    const codemode = runtimeGroups.find((g) => g.id === "codemode")!;
    const skills = runtimeGroups.find((g) => g.id === "skills")!;
    const evals = runtimeGroups.find((g) => g.id === "evals")!;
    const observability = runtimeGroups.find((g) => g.id === "observability")!;

    // ── TIER 1: Pre-LLM (Governance, Prompt, LLM Routing) ──────────
    nodes.push({
      id: "rt-governance",
      type: "category",
      position: { x: -TIER1_X, y: TIER1_Y },
      data: {
        label: governance.label, count: governance.items.length,
        subtitle: governance.subtitle,
        tooltip: governance.tooltip,
        icon: governance.icon, color: governance.color, accent: governance.accent,
        items: governance.items,
        pulsing: pulsingIds.has("rt-governance"),
      },
      draggable: true,
    });

    nodes.push({
      id: "prompt",
      type: "prompt",
      position: { x: 0, y: TIER1_Y },
      data: { systemPrompt },
      draggable: true,
    });

    nodes.push({
      id: "rt-llm-routing",
      type: "category",
      position: { x: TIER1_X, y: TIER1_Y },
      data: {
        label: llmRouting.label, count: llmRouting.items.length,
        subtitle: llmRouting.subtitle,
        tooltip: llmRouting.tooltip,
        icon: llmRouting.icon, color: llmRouting.color, accent: llmRouting.accent,
        items: llmRouting.items,
        pulsing: pulsingIds.has("rt-llm-routing"),
      },
      draggable: true,
    });

    // ── TIER 2: The Core Agent ─────────────────────────────────────
    nodes.push({
      id: "core",
      type: "agentCore",
      position: { x: 0, y: TIER2_Y },
      data: {
        agentName, plan, modelOverride,
        budgetLimit: budgetEnabled ? budgetLimit : 0,
        maxTurns, isActive,
        pulsing: pulsingIds.has("core"),
      },
      draggable: true,
    });

    // ── TIER 3: Codemode + capability satellites + Skills ──────────
    // Layout: [codemode]  [cat-1]  [cat-2]  ...  [cat-N]  [skills]
    // Codemode/Skills flank the row at TIER3_SPACING outside the
    // leftmost/rightmost capability. Falls back to a sensible default
    // when there are no capabilities yet.
    const toolCats = categorizeTools(tools);
    const activeToolCats = Object.entries(toolCats).filter(([, items]) => items.length > 0);
    const capCount = activeToolCats.length;

    let capStartX: number;
    let codemodeX: number;
    let skillsX: number;
    if (capCount === 0) {
      // No tools yet — keep codemode/skills equidistant from center
      capStartX = 0;
      codemodeX = -TIER3_SPACING;
      skillsX = TIER3_SPACING;
    } else {
      const capWidth = (capCount - 1) * TIER3_SPACING;
      capStartX = -capWidth / 2;
      codemodeX = capStartX - TIER3_SPACING;
      skillsX = capStartX + capWidth + TIER3_SPACING;
    }

    nodes.push({
      id: "rt-codemode",
      type: "category",
      position: { x: codemodeX, y: TIER3_Y },
      data: {
        label: codemode.label, count: codemode.items.length,
        subtitle: codemode.subtitle,
        tooltip: codemode.tooltip,
        icon: codemode.icon, color: codemode.color, accent: codemode.accent,
        items: codemode.items,
        pulsing: pulsingIds.has("rt-codemode"),
      },
      draggable: true,
    });

    activeToolCats.forEach(([cat, items], i) => {
      const def = categoryDefs[cat] || categoryDefs["Other"];
      const catId = `cat-${cat.toLowerCase().replace(/\s+/g, "-")}`;
      nodes.push({
        id: catId,
        type: "category",
        position: { x: capStartX + i * TIER3_SPACING, y: TIER3_Y },
        data: {
          label: cat, count: items.length,
          subtitle: `${items.length} tool${items.length === 1 ? "" : "s"}`,
          icon: def.icon, color: def.color, accent: def.accent,
          items,
          pulsing: pulsingIds.has(catId),
          dropTarget: dropTargetIds.has(catId),
          dropPreview: dropTargetIds.has(catId) ? dropPreview : null,
        },
        draggable: true,
      });
    });

    nodes.push({
      id: "rt-skills",
      type: "category",
      position: { x: skillsX, y: TIER3_Y },
      data: {
        label: skills.label, count: skills.items.length,
        subtitle: skills.subtitle,
        tooltip: skills.tooltip,
        icon: skills.icon, color: skills.color, accent: skills.accent,
        items: skills.items,
        pulsing: pulsingIds.has("rt-skills"),
      },
      draggable: true,
    });

    // ── TIER 4: Sinks (Evals, Observability) — centered under core ──
    nodes.push({
      id: "rt-evals",
      type: "category",
      position: { x: -TIER4_OFFSET, y: TIER4_Y },
      data: {
        label: evals.label, count: evals.items.length,
        subtitle: evals.subtitle,
        tooltip: evals.tooltip,
        icon: evals.icon, color: evals.color, accent: evals.accent,
        items: evals.items,
        pulsing: pulsingIds.has("rt-evals"),
      },
      draggable: true,
    });

    nodes.push({
      id: "rt-observability",
      type: "category",
      position: { x: TIER4_OFFSET, y: TIER4_Y },
      data: {
        label: observability.label, count: observability.items.length,
        subtitle: observability.subtitle,
        tooltip: observability.tooltip,
        icon: observability.icon, color: observability.color, accent: observability.accent,
        items: observability.items,
        pulsing: pulsingIds.has("rt-observability"),
      },
      draggable: true,
    });

    return nodes;
  }

  function buildEdges(): Edge[] {
    const edges: Edge[] = [];

    // ── Edge styling ────────────────────────────────────────────────
    // Three semantic stroke colors with high opacity (0.7-0.85) and a
    // 1.5px stroke so connections are clearly visible against the dotted
    // background. Smoothstep type with borderRadius gives orthogonal
    // routing with smooth bends — sharper than bezier, cleaner than step.
    const PRIMITIVE_EDGE = "stroke: rgb(129 140 248 / 0.85); stroke-width: 1.5;";
    const CAPABILITY_EDGE = "stroke: rgb(52 211 153 / 0.75); stroke-width: 1.5;";
    const SINK_EDGE = "stroke: rgb(148 163 184 / 0.7); stroke-width: 1.5;";
    const PROMPT_EDGE = "stroke: hsl(var(--muted-foreground) / 0.65); stroke-width: 1.5; stroke-dasharray: 4 4;";

    // ── Routing rules ───────────────────────────────────────────────
    // Tier 1 (above core) → Core: source = bottom of tier 1 node,
    //                              target = top of core
    // Tier 3 (below core) → Core: source = TOP of tier 3 node,
    //                              target = BOTTOM of core (no U-turn)
    // Core → Tier 4 (below tier 3): source = bottom of core,
    //                                target = top of sink
    //
    // Without explicit handle hints, xyflow defaults to top-target +
    // bottom-source on every edge, which forces tier 3 → core edges to
    // exit at the bottom and route all the way around the layout.
    const EDGE_OPTS = {
      type: "smoothstep" as const,
      pathOptions: { borderRadius: 16 },
    };

    // ── Tier 1 → Core (downward, default handles work) ──
    edges.push({
      id: "edge-prompt-core",
      source: "prompt", target: "core",
      sourceHandle: "bottom-source", targetHandle: "top-target",
      style: PROMPT_EDGE, ...EDGE_OPTS,
    });
    edges.push({
      id: "edge-governance-core",
      source: "rt-governance", target: "core",
      sourceHandle: "bottom-source", targetHandle: "top-target",
      style: PRIMITIVE_EDGE, ...EDGE_OPTS,
    });
    edges.push({
      id: "edge-llm-routing-core",
      source: "rt-llm-routing", target: "core",
      sourceHandle: "bottom-source", targetHandle: "top-target",
      style: PRIMITIVE_EDGE, ...EDGE_OPTS,
    });

    // ── Tier 3 → Core (upward, must use top-source + core bottom-target) ──
    edges.push({
      id: "edge-codemode-core",
      source: "rt-codemode", target: "core",
      sourceHandle: "top-source", targetHandle: "bottom-target",
      style: PRIMITIVE_EDGE, ...EDGE_OPTS,
    });
    edges.push({
      id: "edge-skills-core",
      source: "rt-skills", target: "core",
      sourceHandle: "top-source", targetHandle: "bottom-target",
      style: CAPABILITY_EDGE, ...EDGE_OPTS,
    });
    const toolCats = categorizeTools(tools);
    for (const [cat, items] of Object.entries(toolCats)) {
      if (items.length === 0) continue;
      const id = `cat-${cat.toLowerCase().replace(/\s+/g, "-")}`;
      edges.push({
        id: `edge-${id}-core`,
        source: id, target: "core",
        sourceHandle: "top-source", targetHandle: "bottom-target",
        style: CAPABILITY_EDGE, ...EDGE_OPTS,
      });
    }

    // ── Core → Tier 4 (downward, source = core bottom-source) ──
    edges.push({
      id: "edge-core-evals",
      source: "core", target: "rt-evals",
      sourceHandle: "bottom-source", targetHandle: "top-target",
      style: SINK_EDGE, ...EDGE_OPTS,
    });
    edges.push({
      id: "edge-core-observability",
      source: "core", target: "rt-observability",
      sourceHandle: "bottom-source", targetHandle: "top-target",
      style: SINK_EDGE, ...EDGE_OPTS,
    });

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
    buildChannels,
    buildRuntimeGroups,
    markDirty,
  };
}

export type CanvasStore = ReturnType<typeof createCanvasStore>;
