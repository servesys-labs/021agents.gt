/**
 * Runtime Types
 * 
 * TypeScript types shared between the runtime and portal for graph definitions.
 */

// --- Graph Types ---

export interface GraphNode {
  id: string;
  type: string;
  position?: { x: number; y: number };
  label?: string;
  config?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
  condition?: string;
}

export interface GraphSubgraph {
  name: string;
  label?: string;
  nodes: string[];
}

export interface GraphSpec {
  nodes: GraphNode[];
  edges: GraphEdge[];
  subgraphs?: GraphSubgraph[];
}

// --- Runtime Events ---

export type RuntimeEventType =
  | "connected"
  | "session_start"
  | "turn_start"
  | "token"
  | "tool_call"
  | "tool_result"
  | "turn_end"
  | "done"
  | "error"
  | "warning";

export interface RuntimeEventBase {
  type: RuntimeEventType;
  version: string;
  timestamp: string;
}

export interface TokenEvent extends RuntimeEventBase {
  type: "token";
  session_id: string;
  turn_id: string;
  token: string;
}

export interface ToolCallEvent extends RuntimeEventBase {
  type: "tool_call";
  session_id: string;
  turn_id: string;
  tool_call: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ToolResultEvent extends RuntimeEventBase {
  type: "tool_result";
  session_id: string;
  turn_id: string;
  tool_result: {
    tool_call_id: string;
    output?: unknown;
    error?: string;
    duration_ms?: number;
  };
}

export interface TurnEndEvent extends RuntimeEventBase {
  type: "turn_end";
  session_id: string;
  turn_id: string;
  turn: {
    model: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };
  };
}

export interface DoneEvent extends RuntimeEventBase {
  type: "done";
  session_id: string;
  output?: unknown;
}

export interface ErrorEvent extends RuntimeEventBase {
  type: "error";
  session_id?: string;
  turn_id?: string;
  error: string;
  code?: string;
  retryable?: boolean;
}

export type RuntimeEvent =
  | TokenEvent
  | ToolCallEvent
  | ToolResultEvent
  | TurnEndEvent
  | DoneEvent
  | ErrorEvent;

// --- Agent Types ---

export interface AgentConfig {
  name: string;
  description?: string;
  version?: string;
  system_prompt?: string;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  tools?: string[];
  memory?: {
    working?: { max_items?: number };
    episodic?: { max_episodes?: number; ttl_days?: number };
    procedural?: { max_procedures?: number };
  };
  governance?: {
    budget_limit_usd?: number;
    blocked_tools?: string[];
    require_confirmation_for_destructive?: boolean;
  };
  max_turns?: number;
  timeout_seconds?: number;
  graph?: GraphSpec;
}

// --- Component Registry ---

export interface Component {
  component_id: string;
  org_id?: string;
  type: "graph" | "prompt" | "tool_set";
  name: string;
  version: string;
  content: unknown;
  is_public: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface SubgraphDefinition extends Component {
  type: "graph";
  content: {
    graph: GraphSpec;
    input_schema?: Record<string, string>;
    output_schema?: Record<string, string>;
  };
}

// --- Prompt Versioning ---

export interface PromptVersion {
  prompt_id: string;
  version: string;
  template: string;
  variables: string[];
  is_active: boolean;
  traffic_percent: number;
  eval_score?: number;
  created_at?: string;
}

// --- Schema ---

export interface JsonSchema {
  type: "object" | "array" | "string" | "number" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
}

export interface NodeSchema {
  node_id: string;
  input_schema?: JsonSchema;
  output_schema?: JsonSchema;
}
