import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { apiPost } from "../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
};

export type PageContext = {
  page: string;
  agentName?: string;
  sessionId?: string;
  issueId?: string;
};

type MetaAgentState = {
  /** Chat history */
  messages: ChatMessage[];
  /** Whether a request is in flight */
  processing: boolean;
  /** Panel open state */
  panelOpen: boolean;
  /** Current page context derived from the route */
  pageContext: PageContext;

  /** Send a message to the meta-agent */
  send: (prompt: string) => Promise<void>;
  /** Open/close the chat panel */
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  /** Clear chat history */
  clearHistory: () => void;
  /** Get context-aware suggestion prompts for the current page */
  suggestions: Suggestion[];
};

export type Suggestion = {
  label: string;
  prompt: string;
  icon?: string;
};

/* ── Context ────────────────────────────────────────────────────── */

const MetaAgentContext = createContext<MetaAgentState | null>(null);

export function useMetaAgent(): MetaAgentState {
  const ctx = useContext(MetaAgentContext);
  if (!ctx) throw new Error("useMetaAgent must be used within MetaAgentProvider");
  return ctx;
}

/* ── Page-aware suggestions ─────────────────────────────────────── */

function getSuggestions(ctx: PageContext): Suggestion[] {
  const { page, agentName } = ctx;

  /*
   * Route matching order matters:
   * 1. Exact matches first (/, /agents, /agents/new)
   * 2. Parameterized matches (/agents/:name) — requires agentName
   * 3. Prefix matches (/sessions/*, /issues/*, etc.)
   * 4. Default fallback
   */

  // Dashboard — general getting-started
  if (page === "/") {
    return [
      { label: "Create an agent", prompt: "Create a customer support agent that can look up orders and process refunds", icon: "+" },
      { label: "Show failing agents", prompt: "Which agents have the highest error rate right now?", icon: "!" },
      { label: "Summarize activity", prompt: "Give me a summary of agent activity and costs from the past 24 hours", icon: "~" },
    ];
  }

  // Agent creation / list — exact matches before parameterized
  if (page === "/agents" || page === "/agents/new") {
    return [
      { label: "Create from description", prompt: "Create an agent that handles customer support tickets with access to order lookup and refund tools", icon: "+" },
      { label: "Suggest tools", prompt: agentName ? `Suggest the best tools for ${agentName}` : "What tools should a support agent have?", icon: "W" },
      { label: "Generate system prompt", prompt: agentName ? `Write an optimal system prompt for ${agentName}` : "Write a system prompt for a data analysis agent", icon: "P" },
    ];
  }

  // Agent detail — config, testing, improvement (parameterized, must come after exact /agents match)
  if (agentName && (page === `/agents/${agentName}` || page.startsWith(`/agents/${agentName}/`))) {
    return [
      { label: "Analyze performance", prompt: `Analyze the recent performance of ${agentName} — quality scores, error rate, and latency trends`, icon: "~" },
      { label: "Suggest improvements", prompt: `Review ${agentName}'s config and suggest improvements to reduce errors and improve quality`, icon: "*" },
      { label: "Run eval loop", prompt: `Run an eval loop for ${agentName}: pick tasks, run trials, summarize failures, and propose improvements`, icon: ">" },
    ];
  }

  // Sessions / traces — debugging
  if (page.startsWith("/sessions")) {
    return [
      { label: "Find failures", prompt: "Show me sessions that failed in the last 24 hours and group by error type", icon: "!" },
      { label: "Cost analysis", prompt: "Which sessions were the most expensive and why?", icon: "$" },
    ];
  }

  // Issues — triage
  if (page.startsWith("/issues")) {
    return [
      { label: "Auto-triage", prompt: "Analyze the open high-severity issues and suggest a triage plan", icon: "!" },
      { label: "Root cause", prompt: "What's the most common root cause across recent issues?", icon: "?" },
    ];
  }

  // Security / compliance
  if (page.startsWith("/security") || page.startsWith("/compliance")) {
    return [
      { label: "Security summary", prompt: "Summarize the current security posture across all agents — risk scores, open findings, and compliance status", icon: "S" },
      { label: "Run scan", prompt: "Which agents should be scanned next based on recent changes?", icon: ">" },
    ];
  }

  // Tools
  if (page.startsWith("/tools")) {
    return [
      { label: "Recommend tools", prompt: "What tools would you recommend adding to the registry for a typical enterprise setup?", icon: "+" },
    ];
  }

  // Workflows
  if (page.startsWith("/workflows")) {
    return [
      { label: "Design workflow", prompt: "Design a multi-step workflow for ingesting documents, chunking, embedding, and indexing into the RAG pipeline", icon: "+" },
    ];
  }

  // Default fallback
  return [
    { label: "What can you do?", prompt: "What can you help me with on this page?", icon: "?" },
    { label: "System status", prompt: "Give me a quick health check of the platform — API, database, middleware", icon: "~" },
  ];
}

/* ── Provider ───────────────────────────────────────────────────── */

export function MetaAgentProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [processing, setProcessing] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  /* ── Derive page context from current route ──────────────── */
  const pageContext = useMemo<PageContext>(() => {
    const path = location.pathname;
    const segments = path.split("/").filter(Boolean);

    const ctx: PageContext = { page: path };

    // Extract agentName from /agents/:name patterns
    if (segments[0] === "agents" && segments.length >= 2 && segments[1] !== "new") {
      ctx.agentName = segments[1];
    }

    // Extract sessionId from /agents/:name/sessions/:sessionId
    if (segments[2] === "sessions" && segments[3]) {
      ctx.sessionId = segments[3];
    }

    // Extract issueId from /agents/:name/issues/:issueId
    if (segments[2] === "issues" && segments[3]) {
      ctx.issueId = segments[3];
    }

    return ctx;
  }, [location.pathname]);

  /* ── Context-aware suggestions ───────────────────────────── */
  const suggestions = useMemo(() => getSuggestions(pageContext), [pageContext]);

  /* ── Send message to meta-agent ──────────────────────────── */
  const send = useCallback(
    async (prompt: string) => {
      const userMsg: ChatMessage = { role: "user", text: prompt, timestamp: Date.now() };
      setMessages((prev) => [...prev, userMsg].slice(-100));
      setProcessing(true);

      try {
        // Use the create-from-description endpoint for agent creation prompts,
        // otherwise use a generic agent run endpoint
        // Intent detection: match "create/build/make agent" but exclude
        // non-agent-creation uses like "create a Docker image" or "how do I create"
        const hasCreationVerb = /\b(create|build|make|set up|configure|design)\b/i.test(prompt);
        const hasAgentNoun = /\b(agent|bot|assistant)\b/i.test(prompt);
        const isQuestion = /^(how|what|why|can|does|do|is|should)\b/i.test(prompt.trim());
        const hasNegativeContext = /\b(docker|image|file|database|table|branch|repo|PR|pull request)\b/i.test(prompt);
        const isCreationPrompt = hasCreationVerb && hasAgentNoun && !isQuestion && !hasNegativeContext;

        let responseText: string;

        if (isCreationPrompt) {
          const result = await apiPost<{
            agent?: { name?: string; description?: string; model?: string; tools?: string[] };
            lint_report?: { valid?: boolean; errors?: string[]; warnings?: string[] };
          }>("/api/v1/agents/create-from-description", {
            description: prompt,
            draft_only: true,
            auto_graph: true,
            tools: "auto",
          });

          const agent = result.agent;
          if (agent) {
            const toolList = agent.tools?.length
              ? agent.tools.join(", ")
              : "none";
            responseText = `I've drafted an agent configuration:\n\n**${agent.name}** — ${agent.description}\n- Model: ${agent.model}\n- Tools: ${toolList}\n\nYou can review and deploy it from the Agents page.`;
            if (result.lint_report && !result.lint_report.valid) {
              responseText += `\n\nLint warnings: ${(result.lint_report.warnings || []).join(", ")}`;
            }
          } else {
            responseText = "I generated a draft but the response was incomplete. Try creating the agent from the Agents page.";
          }
        } else {
          // Generic meta-agent query — route through a lightweight agent run
          try {
            const result = await apiPost<{ output?: string; error?: string }>(
              "/api/v1/agents/meta-agent/run",
              { task: prompt, metadata: { source: "portal-assist", page: pageContext.page } },
            );
            responseText = result.output || result.error || "No response from meta-agent.";
          } catch {
            // Fallback: provide a helpful response based on context
            responseText = getOfflineResponse(prompt, pageContext);
          }
        }

        const assistantMsg: ChatMessage = {
          role: "assistant",
          text: responseText,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, assistantMsg].slice(-100));
      } catch (err) {
        const errorMsg: ChatMessage = {
          role: "assistant",
          text: `Something went wrong: ${err instanceof Error ? err.message : "Unknown error"}. Try again or check the console.`,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMsg].slice(-100));
      } finally {
        setProcessing(false);
      }
    },
    [pageContext],
  );

  const openPanel = useCallback(() => setPanelOpen(true), []);
  const closePanel = useCallback(() => setPanelOpen(false), []);
  const togglePanel = useCallback(() => setPanelOpen((p) => !p), []);
  const clearHistory = useCallback(() => setMessages([]), []);

  const value = useMemo<MetaAgentState>(
    () => ({
      messages,
      processing,
      panelOpen,
      pageContext,
      send,
      openPanel,
      closePanel,
      togglePanel,
      clearHistory,
      suggestions,
    }),
    [messages, processing, panelOpen, pageContext, send, openPanel, closePanel, togglePanel, clearHistory, suggestions],
  );

  return (
    <MetaAgentContext.Provider value={value}>
      {children}
    </MetaAgentContext.Provider>
  );
}

/* ── Offline fallback response ──────────────────────────────────── */

function getOfflineResponse(prompt: string, ctx: PageContext): string {
  const lower = prompt.toLowerCase();

  if (lower.includes("fail") || lower.includes("error")) {
    return "To investigate failures, check the **Issues** page for triaged errors, or go to **Sessions** and filter by status 'error' to see recent failed runs with turn-by-turn traces.";
  }
  if (lower.includes("cost") || lower.includes("expensive")) {
    return "You can view cost breakdowns on the **Dashboard** (Cost Overview card) or check individual session costs on the **Sessions** page. The cost ledger at `/api/v1/observability/cost-ledger` has detailed per-agent breakdowns.";
  }
  if (lower.includes("tool") || lower.includes("recommend")) {
    return "Visit the **Tools** page to browse the registry. When creating an agent, the platform auto-recommends tools based on your description. Common tools include `web_search`, `sandbox_exec`, `file_read`, and `http_request`.";
  }
  if (lower.includes("deploy") || lower.includes("release")) {
    return "To deploy an agent: go to the agent's detail page, navigate to the **Releases** tab, create a release channel, and promote your agent with a traffic percentage for canary rollouts.";
  }
  if (lower.includes("eval") || lower.includes("quality")) {
    return "Run evaluations from the agent's **Eval** tab or the **Intelligence** page. Evals test your agent against task scenarios and produce quality scores, failure analysis, and improvement suggestions.";
  }

  return `I understand you're asking about "${prompt.slice(0, 80)}". The meta-agent backend is currently unavailable, but you can explore the relevant features through the sidebar navigation. Try the **Agents**, **Sessions**, or **Intelligence** pages.`;
}
