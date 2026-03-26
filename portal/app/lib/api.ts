/**
 * Portal API Client
 * 
 * Client-side API for interacting with control-plane endpoints.
 */

import type { GraphSpec, Component, SubgraphDefinition } from "./runtime-types";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8787";

// --- Types ---

export interface ApiError {
  error: string;
  details?: unknown;
}

export interface GraphListResponse {
  graphs: Array<{
    id: string;
    name: string;
    description?: string;
    type: string;
    version: string;
    updated_at: string;
  }>;
  pagination: { limit: number; offset: number; total?: number };
}

export interface GraphDetailResponse {
  id: string;
  name: string;
  type: "graph";
  description?: string;
  content: {
    graph: GraphSpec;
    input_schema?: Record<string, string>;
    output_schema?: Record<string, string>;
  };
  version: string;
  tags: string[];
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

export interface GraphValidationResponse {
  valid: boolean;
  errors: Array<{ code: string; message: string; path?: string }>;
  warnings?: Array<{ code: string; message: string }>;
  execution_order?: string[];
  expanded_graph?: GraphSpec;
}

export interface GraphExecutionResponse {
  success: boolean;
  output: string;
  cost_usd: number;
  latency_ms: number;
  turns: number;
  tool_calls: number;
  error?: string;
}

// --- Helper ---

async function fetchApi<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// --- Graph APIs ---

export async function listGraphs(params?: {
  type?: "graph" | "prompt" | "tool_set";
  search?: string;
  limit?: number;
  offset?: number;
  includePublic?: boolean;
}): Promise<GraphListResponse> {
  const query = new URLSearchParams();
  if (params?.type) query.set("type", params.type);
  if (params?.search) query.set("search", params.search);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.offset) query.set("offset", String(params.offset));
  if (params?.includePublic) query.set("include_public", "true");

  return fetchApi<GraphListResponse>(`/api/v1/components?${query}`);
}

export async function getGraph(id: string): Promise<GraphDetailResponse> {
  return fetchApi<GraphDetailResponse>(`/api/v1/components/${id}`);
}

export async function createGraph(data: {
  name: string;
  description?: string;
  content: GraphDetailResponse["content"];
  tags?: string[];
  is_public?: boolean;
}): Promise<{ id: string; version: string }> {
  return fetchApi<{ id: string; version: string }>("/api/v1/components", {
    method: "POST",
    body: JSON.stringify({
      type: "graph",
      ...data,
    }),
  });
}

export async function updateGraph(
  id: string,
  data: Partial<{
    description: string;
    content: GraphDetailResponse["content"];
    tags: string[];
    is_public: boolean;
  }>
): Promise<{ updated: boolean; new_version: string }> {
  return fetchApi<{ updated: boolean; new_version: string }>(`/api/v1/components/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteGraph(id: string): Promise<{ deleted: string }> {
  return fetchApi<{ deleted: string }>(`/api/v1/components/${id}`, {
    method: "DELETE",
  });
}

export async function forkGraph(id: string): Promise<{ id: string; name: string }> {
  return fetchApi<{ id: string; name: string }>(`/api/v1/components/${id}/fork`, {
    method: "POST",
  });
}

// --- Graph Operations ---

export async function validateGraph(
  graph: GraphSpec,
  options?: {
    maxBranching?: number;
    maxFanin?: number;
    expandSubgraphs?: boolean;
  }
): Promise<GraphValidationResponse> {
  return fetchApi<GraphValidationResponse>("/api/v1/graphs/validate", {
    method: "POST",
    body: JSON.stringify({
      graph,
      ...options,
    }),
  });
}

export async function executeGraph(
  graph: GraphSpec,
  input: string,
  options?: {
    agent_name?: string;
    org_id?: string;
    max_turns?: number;
  }
): Promise<GraphExecutionResponse> {
  return fetchApi<GraphExecutionResponse>("/api/v1/graphs/execute", {
    method: "POST",
    body: JSON.stringify({
      graph,
      input,
      ...options,
    }),
  });
}

export async function streamExecuteGraph(
  graph: GraphSpec,
  input: string,
  onEvent: (event: unknown) => void,
  options?: {
    agent_name?: string;
    org_id?: string;
  }
): Promise<void> {
  const response = await fetch(`${API_BASE}/api/v1/graphs/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      graph,
      input,
      ...options,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6));
          onEvent(event);
        } catch {
          // Ignore malformed events
        }
      }
    }
  }
}

// --- Subgraph APIs ---

export async function listSubgraphs(orgId?: string): Promise<SubgraphDefinition[]> {
  const query = orgId ? `?org_id=${orgId}` : "";
  return fetchApi<SubgraphDefinition[]>(`/api/v1/subgraphs${query}`);
}

export async function getSubgraph(id: string): Promise<SubgraphDefinition> {
  return fetchApi<SubgraphDefinition>(`/api/v1/subgraphs/${id}`);
}

// --- Catalog APIs ---

export async function getCatalog(): Promise<{
  builtin: Component[];
  popular: Component[];
}> {
  return fetchApi<{ builtin: Component[]; popular: Component[] }>("/api/v1/components/catalog/list");
}

// --- Agent Graph APIs ---

export async function getAgentGraph(agentName: string): Promise<{
  agent_name: string;
  declarative_graph?: GraphSpec;
}> {
  return fetchApi<{ agent_name: string; declarative_graph?: GraphSpec }>(
    `/api/v1/agents/${agentName}/graph`
  );
}

export async function updateAgentGraph(
  agentName: string,
  graph: GraphSpec
): Promise<{ updated: boolean }> {
  return fetchApi<{ updated: boolean }>(`/api/v1/agents/${agentName}/graph`, {
    method: "PUT",
    body: JSON.stringify({ graph }),
  });
}

// --- Mermaid Export ---

export async function exportGraphMermaid(graph: GraphSpec): Promise<{ mermaid: string }> {
  return fetchApi<{ mermaid: string }>("/api/v1/graphs/export/mermaid", {
    method: "POST",
    body: JSON.stringify({ graph }),
  });
}
