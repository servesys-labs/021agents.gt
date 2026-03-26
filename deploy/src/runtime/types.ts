import type { Sandbox } from "@cloudflare/sandbox";

/**
 * Edge Runtime — shared types for graph execution at the edge.
 *
 * These mirror the backend Python contracts (TurnResult, LLMResponse, etc.)
 * so the API response shape is identical regardless of execution location.
 */

// ── LLM ────────────────────────────────────────────────────────

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface LLMResponse {
  content: string;
  model: string;
  tool_calls: ToolCall[];
  usage: { input_tokens: number; output_tokens: number };
  cost_usd: number;
  latency_ms: number;
  // AI Gateway correlation IDs — used to look up exact cost from gateway logs API
  gateway_log_id?: string;
  gateway_event_id?: string;
}

// ── Tools ──────────────────────────────────────────────────────

export interface ToolResult {
  tool: string;
  tool_call_id: string;
  result: string;
  error?: string;
  latency_ms: number;
  cost_usd?: number;  // Tool execution cost (e.g., search API calls)
}

// ── Turn ───────────────────────────────────────────────────────

export interface TurnResult {
  turn_number: number;
  content: string;
  tool_results: ToolResult[];
  done: boolean;
  stop_reason: string;
  error?: string;
  cost_usd: number;
  cumulative_cost_usd: number;
  model: string;
  execution_mode: "sequential" | "parallel";
  latency_ms: number;
}

// ── Agent Config (loaded from Supabase) ────────────────────────

export interface AgentConfig {
  agent_name: string;
  system_prompt: string;
  provider: string;
  model: string;
  plan: string;
  max_turns: number;
  budget_limit_usd: number;
  timeout_seconds?: number; // Default: 300 (5 minutes)
  tools: string[];
  blocked_tools: string[];
  allowed_domains: string[];           // Domain allowlist for HTTP/browse tools
  max_tokens_per_turn: number;         // Token cap per LLM call (0 = unlimited)
  require_confirmation_for_destructive: boolean; // Halt on delete/drop/destroy
  parallel_tool_calls: boolean;
  require_human_approval?: boolean;
  org_id: string;
  project_id: string;
  state_reducers?: Record<string, string>;
  // Routing overrides per complexity tier
  routing?: Record<string, { provider: string; model: string; max_tokens: number }>;
  // Codemode middleware hooks — snippet IDs to run at each hook point
  codemode_middleware?: {
    pre_llm?: string;     // Run before LLM call (can modify messages)
    post_llm?: string;    // Run after LLM response (can modify output)
    pre_tool?: string;    // Run before tool execution (can block/modify)
    post_tool?: string;   // Run after tool results (can filter/modify)
    pre_output?: string;  // Run before final output (can transform)
  };
  // Codemode observability processor snippet ID
  codemode_observability?: string;
}

// ── Runtime Context (flows through graph nodes) ────────────────

export interface RuntimeContext {
  session_id: string;
  trace_id: string;
  messages: LLMMessage[];
  tools: ToolDefinition[];
  config: AgentConfig;
  turn: number;
  cumulative_cost_usd: number;
  done: boolean;
  results: TurnResult[];
  events: RuntimeEvent[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ── Events (telemetry) ─────────────────────────────────────────
// Event types aligned with backend agentos/core/events.py EventType enum.

export type RuntimeEventType =
  // Core lifecycle
  | "session_start"
  | "session_end"
  | "session_resume"
  | "turn_start"
  | "turn_end"
  | "task_received"
  // LLM
  | "llm_request"
  | "llm_response"
  // Tools
  | "tool_call"
  | "tool_result"
  // Graph nodes
  | "node_start"
  | "node_end"
  | "node_error"
  // Governance
  | "governance_check"
  // Memory/RAG
  | "memory_read"
  | "rag_query"
  // Errors
  | "error";

export interface RuntimeEvent {
  event_id: string;
  event_type: RuntimeEventType;
  trace_id: string;
  session_id: string;
  turn: number;
  data: Record<string, unknown>;
  timestamp: number;
  source: string;
}

// ── Env subset needed by runtime ───────────────────────────────

export interface RuntimeEnv {
  AI: Ai;
  HYPERDRIVE: Hyperdrive;
  VECTORIZE: VectorizeIndex;
  STORAGE: R2Bucket;
  SANDBOX: DurableObjectNamespace<Sandbox<any>>;
  LOADER: any;
  TELEMETRY_QUEUE: Queue;
  BROWSER: Fetcher;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  AI_GATEWAY_ID?: string;        // CF AI Gateway slug (e.g. "one-shots")
  AI_GATEWAY_TOKEN?: string;     // Gateway auth token (all providers, no BYOK needed)
  BRAVE_SEARCH_KEY?: string;     // Brave Search API key (X-Subscription-Token)
  DEFAULT_PROVIDER: string;
  DEFAULT_MODEL: string;
  OPENROUTER_API_KEY?: string;
}

// ── Runnable API parity envelopes ───────────────────────────────

export interface RunnableRunMetadata {
  success: boolean;
  turns: number;
  tool_calls: number;
  cost_usd: number;
  latency_ms: number;
  session_id: string;
  trace_id: string;
  run_id: string;
  stop_reason: string;
  checkpoint_id: string;
  parent_session_id: string;
  resumed_from_checkpoint: string;
  run_name: string;
  tags: string[];
  metadata: Record<string, unknown>;
  input_raw: unknown;
}

export interface RunnableInvokeResponse {
  output: string;
  metadata: RunnableRunMetadata;
}

// ── Edge run / checkpoint (shared by engine + edge_graph) ───────

export interface RunRequest {
  agent_name: string;
  task: string;
  org_id?: string;
  project_id?: string;
  channel?: string;
  channel_user_id?: string;
  run_name?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  input_raw?: unknown;
}

export interface RunResponse {
  success: boolean;
  output: string;
  error?: string;
  turns: number;
  tool_calls: number;
  cost_usd: number;
  latency_ms: number;
  session_id: string;
  trace_id: string;
  stop_reason: string;
  events: RuntimeEvent[];
  run_id?: string;
  checkpoint_id?: string;
  parent_session_id?: string;
  resumed_from_checkpoint?: string;
}

export interface CheckpointPayload {
  checkpoint_id: string;
  session_id: string;
  trace_id: string;
  agent_name: string;
  messages: LLMMessage[];
  current_turn: number;
  cumulative_cost_usd: number;
  status: "pending_approval" | "approved" | "rejected" | "resumed" | "breakpoint";
  created_at: number;
}
