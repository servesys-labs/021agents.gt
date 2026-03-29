/* ── Utility helpers ─────────────────────────────────────────── */

export function toMoney(value: unknown): string {
  return `$${(typeof value === "number" ? value : 0).toFixed(4)}`;
}

export function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function safeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function summarizeCoverage(paths: string[]): {
  total: number;
  v1: number;
  legacy: number;
} {
  let v1 = 0;
  let legacy = 0;
  for (const path of paths) {
    if (path.startsWith("/api/v1/")) v1 += 1;
    else legacy += 1;
  }
  return { total: paths.length, v1, legacy };
}

/* ── Usage & Billing ─────────────────────────────────────────── */

export type BillingSubjectRow = {
  billing_user_id: string;
  api_key_id: string;
  cost_usd: number;
  record_count: number;
};

export type UsageResponse = {
  total_cost_usd?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  by_model?: Record<string, number>;
  by_cost_type?: Record<string, number>;
  by_agent?: Record<string, number>;
  by_billing_subject?: BillingSubjectRow[];
  inference_cost_usd?: number;
  connector_cost_usd?: number;
  gpu_compute_cost_usd?: number;
  telephony_cost_usd?: number;
};

export type DailyUsageResponse = {
  days?: Array<{
    day: string;
    cost?: number;
    call_count?: number;
  }>;
};

/* ── Sessions ────────────────────────────────────────────────── */

export type SessionSummaryResponse = {
  total_sessions?: number;
  avg_duration_seconds?: number;
};

export type SessionInfo = {
  session_id: string;
  agent_name?: string;
  status?: string;
  trace_id?: string;
  parent_session_id?: string | null;
  depth?: number;
  step_count?: number;
  cost_total_usd?: number;
  wall_clock_seconds?: number;
  created_at?: string;
  updated_at?: string;
  messages?: SessionMessage[];
};

export type SessionMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
  tool_calls?: unknown[];
};

export type RuntimeInsightsResponse = {
  sessions_scanned?: number;
  turns_scanned?: number;
  parallel_turns?: number;
  sequential_turns?: number;
  parallel_ratio?: number;
  avg_reflection_confidence?: number;
  next_actions?: Record<string, number>;
  tool_failures_total?: number;
};

/* ── Agents ──────────────────────────────────────────────────── */

export type AgentGovernance = {
  budget_limit_usd: number;
  blocked_tools: string[];
  require_confirmation_for_destructive: boolean;
};

export type AgentInfo = {
  name: string;
  description?: string;
  model?: string;
  tools?: Array<string | Record<string, unknown>>;
  tags?: string[];
  status?: string;
  version?: string;
  created_at?: string;
  updated_at?: string;
};

export type AgentConfig = {
  name: string;
  description: string;
  version: string;
  agent_id: string;
  system_prompt: string;
  personality: string;
  model: string;
  max_tokens: number;
  temperature: number;
  tools: string[];
  max_turns: number;
  timeout_seconds: number;
  plan: string;
  tags: string[];
  deploy_policy?: Record<string, unknown>;
  governance: AgentGovernance;
};

export type AgentCreateRequest = {
  name: string;
  description?: string;
  system_prompt?: string;
  personality?: string;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  tools?: string[];
  max_turns?: number;
  timeout_seconds?: number;
  tags?: string[];
  governance?: Partial<AgentGovernance>;
};

/* ── Workflows & Jobs ────────────────────────────────────────── */

export type WorkflowInfo = {
  id: string;
  name: string;
  description?: string;
  status?: string;
  steps?: WorkflowStep[];
  created_at?: string;
  updated_at?: string;
};

export type WorkflowStep = {
  id: string;
  agent_name: string;
  action: string;
  depends_on?: string[];
};

export type WorkflowCreateRequest = {
  name: string;
  description?: string;
  steps: WorkflowStep[];
};

export type JobInfo = {
  id: string;
  workflow_id?: string;
  status: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
  progress?: number;
};

/* ── Memory ──────────────────────────────────────────────────── */

export type MemoryFact = {
  key: string;
  content: string;
  category?: string;
  confidence?: number;
  created_at?: string;
  updated_at?: string;
};

export type MemoryFactCreateRequest = {
  content: string;
  category?: string;
  confidence?: number;
};

/* ── Knowledge / RAG ─────────────────────────────────────────── */

export type KnowledgeDocument = {
  id: string;
  filename: string;
  status: string;
  chunk_count?: number;
  size_bytes?: number;
  ingested_at?: string;
  error?: string;
};

/* ── Evaluations ─────────────────────────────────────────────── */

export type EvalRun = {
  id: string;
  agent_name: string;
  dataset_name?: string;
  status: string;
  total_tasks?: number;
  completed_tasks?: number;
  pass_rate?: number;
  started_at?: string;
  completed_at?: string;
};

export type EvalRunRequest = {
  agent_name: string;
  dataset_id?: string;
  trials?: number;
};

export type EvalTask = {
  id: string;
  input: string;
  expected_output?: string;
  tags?: string[];
};

/* ── Connectors / Integrations ───────────────────────────────── */

export type ConnectorInfo = {
  id: string;
  name: string;
  type: string;
  status: string;
  tools?: string[];
  config?: Record<string, unknown>;
  created_at?: string;
};

export type ConnectorCreateRequest = {
  name: string;
  type: string;
  config?: Record<string, unknown>;
};

/* ── Webhooks ────────────────────────────────────────────────── */

export type WebhookInfo = {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  secret?: string;
  created_at?: string;
  last_delivery_at?: string;
  last_status?: number;
};

export type WebhookCreateRequest = {
  url: string;
  events: string[];
  active?: boolean;
  secret?: string;
};

/* ── Projects & Environments ─────────────────────────────────── */

export type ProjectInfo = {
  id: string;
  name: string;
  description?: string;
  environments?: EnvironmentInfo[];
  created_at?: string;
};

export type EnvironmentInfo = {
  name: string;
  variables: Record<string, string>;
};

export type ProjectCreateRequest = {
  name: string;
  description?: string;
};

/* ── Releases ────────────────────────────────────────────────── */

export type ReleaseChannel = {
  name: string;
  agent_name: string;
  version: string;
  traffic_pct: number;
  status: string;
  promoted_at?: string;
};

export type CanaryConfig = {
  canary_pct: number;
  canary_version: string;
  stable_version: string;
};

/* ── Schedules ───────────────────────────────────────────────── */

export type ScheduleInfo = {
  id: string;
  name: string;
  cron: string;
  agent_name: string;
  action: string;
  enabled: boolean;
  last_run_at?: string;
  next_run_at?: string;
  created_at?: string;
};

export type ScheduleCreateRequest = {
  name: string;
  cron: string;
  agent_name: string;
  action: string;
  enabled?: boolean;
};

/* ── Governance ──────────────────────────────────────────────── */

export type GovernancePolicy = {
  id: string;
  name: string;
  type: string;
  rules: Record<string, unknown>;
  enabled: boolean;
  created_at?: string;
};

export type GovernancePolicyCreateRequest = {
  name: string;
  type: string;
  rules: Record<string, unknown>;
  enabled?: boolean;
};

/* ── Tool Registry ───────────────────────────────────────────── */

export type ToolInfo = {
  name: string;
  description?: string;
  category?: string;
  parameters?: Record<string, unknown>;
};
