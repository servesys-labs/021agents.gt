/**
 * Shared Zod schemas with OpenAPI metadata — reused across route files.
 *
 * Use `.openapi()` to attach OpenAPI example/description to Zod schemas.
 * These are the building blocks for all `createRoute()` definitions.
 */
import { z } from "@hono/zod-openapi";

// ── Pagination ──────────────────────────────────────────────────────────

export const PaginationQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0, description: "Number of items to skip" }),
  limit: z.coerce.number().int().min(1).max(200).default(50).openapi({ example: 50, description: "Max items to return (1-200)" }),
});

// ── Error responses ─────────────────────────────────────────────────────

export const ErrorSchema = z.object({
  error: z.string().openapi({ example: "Not found" }),
  detail: z.string().optional().openapi({ example: "Agent 'foo' does not exist" }),
}).openapi("Error");

export const RateLimitErrorSchema = z.object({
  error: z.string().openapi({ example: "Too many requests" }),
  retry_after_seconds: z.number().int().optional().openapi({ example: 30 }),
}).openapi("RateLimitError");

export const ValidationErrorSchema = z.object({
  error: z.string(),
  details: z.record(z.unknown()).optional(),
}).openapi("ValidationError");

// ── Auth schemas ────────────────────────────────────────────────────────

export const AuthTokenResponse = z.object({
  token: z.string().openapi({ example: "eyJhbGciOi..." }),
  user_id: z.string().openapi({ example: "a1b2c3d4e5f6" }),
  email: z.string().email().openapi({ example: "user@example.com" }),
  org_id: z.string().openapi({ example: "org_abc123" }),
  provider: z.string().openapi({ example: "local" }),
}).openapi("AuthTokenResponse");

export const UserProfile = z.object({
  user_id: z.string(),
  email: z.string().email(),
  name: z.string(),
  org_id: z.string(),
  role: z.string().openapi({ example: "owner" }),
}).openapi("UserProfile");

export const TokenVerifyResponse = z.object({
  valid: z.boolean(),
  user_id: z.string().optional(),
  email: z.string().optional(),
  org_id: z.string().optional(),
  exp: z.number().optional(),
}).openapi("TokenVerifyResponse");

// ── Agent schemas ───────────────────────────────────────────────────────

export const VALID_REASONING_STRATEGIES = [
  "step-back",
  "chain-of-thought",
  "plan-then-execute",
  "verify-then-respond",
  "decompose",
] as const;

export const AgentCreateBody = z.object({
  name: z.string().min(1).max(128).openapi({ example: "support-agent" }),
  description: z.string().max(2000).default("").openapi({ example: "Customer support agent" }),
  system_prompt: z.string().max(50000).default("You are a helpful AI assistant."),
  personality: z.string().max(2000).default(""),
  model: z.string().max(128).default("").openapi({ example: "claude-sonnet-4-20250514" }),
  max_tokens: z.number().int().min(1).max(200000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  tools: z.array(z.string()).default([]),
  max_turns: z.number().int().min(1).max(1000).default(50),
  timeout_seconds: z.number().int().min(1).max(3600).optional(),
  budget_limit_usd: z.number().min(0).max(10000).default(10),
  tags: z.array(z.string()).default([]),
  graph: z.record(z.unknown()).nullable().optional().default(null),
  strict_graph_lint: z.boolean().default(true),
  auto_graph: z.boolean().default(false),
  reasoning_strategy: z.enum(VALID_REASONING_STRATEGIES).optional(),
  sub_agents: z.array(z.record(z.unknown())).optional(),
  skills: z.array(z.record(z.unknown())).optional(),
  codemode_snippets: z.array(z.record(z.unknown())).optional(),
  guardrails: z.array(z.record(z.unknown())).optional(),
  governance: z.record(z.unknown()).optional(),
  eval_config: z.record(z.unknown()).optional(),
  release_strategy: z.record(z.unknown()).optional(),
  mcp_connectors: z.array(z.record(z.unknown())).optional(),
  deploy_policy: z.record(z.unknown()).optional(),
}).openapi("AgentCreateBody");

export const AgentSummary = z.object({
  name: z.string(),
  description: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  tags: z.array(z.string()),
  version: z.string(),
}).openapi("AgentSummary");

export const AgentTemplate = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tools: z.array(z.string()),
  reasoning_strategy: z.string().optional(),
  tags: z.array(z.string()),
}).openapi("AgentTemplate");

// ── Session schemas ─────────────────────────────────────────────────────

export const SessionSummary = z.object({
  session_id: z.string(),
  agent_name: z.string(),
  status: z.string().openapi({ example: "completed" }),
  input_text: z.string().nullable(),
  output_text: z.string().nullable(),
  step_count: z.number().nullable(),
  cost_total_usd: z.number().nullable(),
  wall_clock_seconds: z.number().nullable(),
  trace_id: z.string().nullable(),
  parent_session_id: z.string().nullable(),
  depth: z.number().nullable(),
  created_at: z.string(),
}).openapi("SessionSummary");

export const TurnDetail = z.object({
  turn_number: z.number(),
  model_used: z.string().nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  latency_ms: z.number().nullable(),
  content: z.string().nullable(),
  cost_total_usd: z.number().nullable(),
  tool_calls: z.string().nullable(),
  execution_mode: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
}).openapi("TurnDetail");

// ── Graph schemas ───────────────────────────────────────────────────────

export const GraphValidateBody = z.object({
  graph: z.record(z.unknown()),
}).openapi("GraphValidateBody");

export const GraphLintBody = z.object({
  graph: z.record(z.unknown()),
  strict: z.boolean().default(false),
}).openapi("GraphLintBody");

export const GraphLintResult = z.object({
  valid: z.boolean(),
  errors: z.array(z.record(z.unknown())),
  warnings: z.array(z.record(z.unknown())),
  summary: z.record(z.unknown()).optional(),
}).openapi("GraphLintResult");

// ── Issue schemas ───────────────────────────────────────────────────────

export const IssueCreateBody = z.object({
  agent_name: z.string().default(""),
  title: z.string().min(1).max(500),
  description: z.string().default(""),
  category: z.string().default("unknown"),
  severity: z.enum(["critical", "high", "medium", "low"]).default("low"),
  source_session_id: z.string().default(""),
}).openapi("IssueCreateBody");

export const IssueUpdateBody = z.object({
  status: z.string().optional(),
  severity: z.string().optional(),
  category: z.string().optional(),
  assigned_to: z.string().optional(),
  suggested_fix: z.string().optional(),
}).openapi("IssueUpdateBody");

export const IssueSummary = z.object({
  issue_id: z.number(),
  agent_name: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  severity: z.string(),
  status: z.string(),
  source_session_id: z.string().nullable(),
  suggested_fix: z.string().nullable(),
  created_at: z.string(),
}).openapi("IssueSummary");

// ── Billing schemas ─────────────────────────────────────────────────────

export const BillingRecord = z.object({
  id: z.number(),
  agent_name: z.string(),
  session_id: z.string().nullable(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
  model: z.string().nullable(),
  created_at: z.string(),
}).openapi("BillingRecord");

export const BillingSummary = z.object({
  total_cost_usd: z.number(),
  total_sessions: z.number(),
  total_input_tokens: z.number(),
  total_output_tokens: z.number(),
  by_agent: z.array(z.object({
    agent_name: z.string(),
    cost_usd: z.number(),
    sessions: z.number(),
  })),
}).openapi("BillingSummary");

// ── Eval schemas ────────────────────────────────────────────────────────

export const EvalRunSummary = z.object({
  run_id: z.number(),
  agent_name: z.string(),
  pass_rate: z.number().nullable(),
  avg_score: z.number().nullable(),
  avg_latency_ms: z.number().nullable(),
  total_cost_usd: z.number().nullable(),
  total_tasks: z.number().nullable(),
  total_trials: z.number().nullable(),
}).openapi("EvalRunSummary");

export const EvalDataset = z.object({
  name: z.string(),
  description: z.string().optional(),
  tasks: z.array(z.record(z.unknown())),
}).openapi("EvalDataset");

// ── Security schemas ────────────────────────────────────────────────────

export const SecurityEvent = z.object({
  id: z.number().optional(),
  event_type: z.string(),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  actor_id: z.string(),
  actor_type: z.string().optional(),
  ip_address: z.string().optional(),
  details: z.record(z.unknown()).optional(),
  created_at: z.string(),
}).openapi("SecurityEvent");

// ── Workflow schemas ────────────────────────────────────────────────────

export const WorkflowSummary = z.object({
  workflow_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  steps: z.array(z.record(z.unknown())),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("WorkflowSummary");

export const ApprovalRequest = z.object({
  agent_name: z.string().min(1),
  run_id: z.string().min(1),
  gate_id: z.string().min(1),
  checkpoint_id: z.string().optional(),
  idempotency_key: z.string().optional(),
  deadline_at: z.union([z.number(), z.string()]).optional(),
  allow_fallback: z.boolean().optional(),
  context: z.record(z.unknown()).optional(),
}).openapi("ApprovalRequest");

export const ApprovalResponse = z.object({
  approval_id: z.string(),
  org_id: z.string(),
  agent_name: z.string(),
  run_id: z.string(),
  gate_id: z.string(),
  status: z.string(),
  decision: z.string().nullable(),
  reviewer_id: z.string().nullable(),
  created_at: z.string(),
}).openapi("ApprovalResponse");

// ── API Key schemas ─────────────────────────────────────────────────────

export const ApiKeyCreateBody = z.object({
  name: z.string().min(1).max(255).default("default"),
  scopes: z.array(z.string()).default(["*"]),
  project_id: z.string().default(""),
  env: z.string().default(""),
  expires_in_days: z.number().int().positive().nullable().optional(),
  ip_allowlist: z.array(z.string()).default([]),
  allowed_agents: z.array(z.string()).default([]),
  rate_limit_rpm: z.number().int().positive().default(60),
  rate_limit_rpd: z.number().int().positive().default(10000),
}).openapi("ApiKeyCreateBody");

export const ApiKeySummary = z.object({
  key_id: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  scopes: z.array(z.string()),
  project_id: z.string().nullable(),
  env: z.string().nullable(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  is_active: z.boolean(),
  ip_allowlist: z.array(z.string()),
  allowed_agents: z.array(z.string()),
  rate_limit_rpm: z.number(),
  rate_limit_rpd: z.number(),
}).openapi("ApiKeySummary");

// ── Org / Project schemas ───────────────────────────────────────────────

export const OrgSummary = z.object({
  org_id: z.string(),
  name: z.string(),
  slug: z.string(),
  plan: z.string(),
  member_count: z.number().optional(),
}).openapi("OrgSummary");

export const OrgMember = z.object({
  user_id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.enum(["owner", "admin", "member", "viewer"]),
  created_at: z.string(),
}).openapi("OrgMember");

export const ProjectSummary = z.object({
  project_id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  default_env: z.string().nullable(),
  default_plan: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("ProjectSummary");

// ── Guardrail schemas ───────────────────────────────────────────────────

export const GuardrailScanBody = z.object({
  text: z.string().min(1).max(200_000),
  scan_type: z.enum(["input", "output"]),
  agent_name: z.string().optional(),
  system_prompt: z.string().optional(),
}).openapi("GuardrailScanBody");

export const GuardrailScanResult = z.object({
  safe: z.boolean(),
  action: z.enum(["allow", "warn", "block"]),
  pii_matches: z.array(z.record(z.unknown())),
  injection_result: z.record(z.unknown()).nullable(),
  safety_issues: z.array(z.record(z.unknown())),
  redacted_text: z.string().optional(),
}).openapi("GuardrailScanResult");

export const GuardrailPolicyBody = z.object({
  name: z.string().min(1).max(200),
  agent_name: z.string().optional(),
  pii_detection: z.boolean().default(true),
  pii_redaction: z.boolean().default(true),
  injection_check: z.boolean().default(true),
  output_safety: z.boolean().default(true),
  max_input_length: z.number().int().min(0).default(50_000),
  blocked_topics: z.array(z.string()).default([]),
}).openapi("GuardrailPolicyBody");

// ── DLP schemas ─────────────────────────────────────────────────────────

export const DlpClassificationBody = z.object({
  name: z.string().min(1).max(200),
  level: z.enum(["public", "internal", "confidential", "restricted"]),
  description: z.string().max(2000).default(""),
  patterns: z.array(z.string()).min(1),
}).openapi("DlpClassificationBody");

export const DlpAgentPolicyBody = z.object({
  allowed_data_levels: z.array(z.enum(["public", "internal", "confidential", "restricted"])).default(["public", "internal"]),
  required_redactions: z.array(z.string()).default([]),
  pii_handling: z.enum(["block", "redact", "allow"]).default("redact"),
  audit_all_access: z.boolean().default(false),
}).openapi("DlpAgentPolicyBody");

// ── SLO schemas ─────────────────────────────────────────────────────────

export const SloCreateBody = z.object({
  metric: z.enum(["success_rate", "p95_latency_ms", "cost_per_run_usd", "avg_turns"]),
  threshold: z.number(),
  agent_name: z.string().min(1),
  env: z.string().default(""),
  operator: z.enum(["gte", "lte", "eq"]).default("gte"),
  window_hours: z.number().int().positive().default(168),
}).openapi("SloCreateBody");

export const SloStatus = z.object({
  slo_id: z.number(),
  metric: z.string(),
  threshold: z.number(),
  operator: z.string(),
  current_value: z.number().nullable(),
  breached: z.boolean(),
  agent_name: z.string(),
  window_hours: z.number(),
}).openapi("SloStatus");

// ── Webhook schemas ─────────────────────────────────────────────────────

export const WebhookSummary = z.object({
  webhook_id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  is_active: z.boolean(),
  failure_count: z.number(),
  last_triggered_at: z.string().nullable(),
}).openapi("WebhookSummary");

export const WebhookCreateBody = z.object({
  url: z.string().url().optional(),
  events: z.array(z.string()).default([]),
  codemode_handler_id: z.string().optional(),
}).openapi("WebhookCreateBody");

// ── Schedule schemas ────────────────────────────────────────────────────

export const ScheduleSummary = z.object({
  schedule_id: z.number(),
  agent_name: z.string(),
  cron: z.string(),
  task: z.string().nullable(),
  is_enabled: z.boolean(),
  run_count: z.number(),
  last_run_at: z.string().nullable(),
}).openapi("ScheduleSummary");

export const ScheduleCreateBody = z.object({
  agent_name: z.string().min(1),
  cron: z.string().min(1),
  task: z.string().optional(),
}).openapi("ScheduleCreateBody");

// ── Connector schemas ───────────────────────────────────────────────────

export const ConnectorTool = z.object({
  name: z.string(),
  description: z.string(),
  app: z.string().optional(),
  provider: z.string().optional(),
}).openapi("ConnectorTool");

export const ConnectorTokenBody = z.object({
  connector_name: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  token_type: z.string().optional(),
  expires_at: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
}).openapi("ConnectorTokenBody");

// ── Component schemas ───────────────────────────────────────────────────

export const ComponentCreateBody = z.object({
  type: z.enum(["graph", "prompt", "tool_set", "node_template"]),
  name: z.string().min(1).max(128),
  description: z.string().max(2000).default(""),
  content: z.record(z.unknown()),
  tags: z.array(z.string()).default([]),
  is_public: z.boolean().default(false),
}).openapi("ComponentCreateBody");

export const ComponentSummary = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  is_public: z.boolean(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number(),
}).openapi("ComponentSummary");

// ── Pipeline schemas ────────────────────────────────────────────────────

export const PipelineStreamBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  schema: z.record(z.unknown()).optional(),
  http_enabled: z.boolean().default(false),
  http_auth: z.string().optional(),
}).openapi("PipelineStreamBody");

export const PipelineSinkBody = z.object({
  name: z.string().min(1),
  type: z.enum(["r2_json", "r2_parquet", "r2_iceberg", "vectorize", "dual"]),
  bucket: z.string().optional(),
  path: z.string().optional(),
  format: z.string().optional(),
  compression: z.string().optional(),
  vectorize_index: z.string().optional(),
  embedding_model: z.string().optional(),
  text_field: z.string().optional(),
}).openapi("PipelineSinkBody");

// ── Release schemas ─────────────────────────────────────────────────────

export const ReleaseSummary = z.object({
  id: z.number(),
  agent_name: z.string(),
  channel: z.string(),
  version: z.string(),
  promoted_by: z.string().nullable(),
  promoted_at: z.string(),
  config_json: z.record(z.unknown()).optional(),
}).openapi("ReleaseSummary");

// ── Memory schemas ──────────────────────────────────────────────────────

export const MemoryEntry = z.object({
  memory_id: z.string(),
  agent_name: z.string(),
  key: z.string(),
  value: z.string(),
  metadata: z.record(z.unknown()).optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("MemoryEntry");

// ── Policy schemas ──────────────────────────────────────────────────────

export const PolicyCreateBody = z.object({
  name: z.string().min(1),
  budget_limit_usd: z.number().optional(),
  blocked_tools: z.array(z.string()).optional(),
  allowed_domains: z.array(z.string()).optional(),
  require_confirmation: z.boolean().optional(),
  max_turns: z.number().int().optional(),
}).openapi("PolicyCreateBody");

export const PolicySummary = z.object({
  policy_id: z.number(),
  name: z.string(),
  budget_limit_usd: z.number().nullable(),
  blocked_tools: z.array(z.string()),
  allowed_domains: z.array(z.string()),
  require_confirmation_for_destructive: z.boolean(),
  max_turns: z.number().nullable(),
}).openapi("PolicySummary");

// ── Common response helpers ─────────────────────────────────────────────

/** Standard 400/401/403/404/409/422/429/500 error responses for createRoute(). */
export const commonErrorResponses = {
  400: {
    description: "Bad request",
    content: { "application/json": { schema: ErrorSchema } },
  },
  401: {
    description: "Missing or invalid authentication",
    content: { "application/json": { schema: ErrorSchema } },
  },
  403: {
    description: "Forbidden — insufficient permissions",
    content: { "application/json": { schema: ErrorSchema } },
  },
  404: {
    description: "Resource not found",
    content: { "application/json": { schema: ErrorSchema } },
  },
  409: {
    description: "Conflict — resource already exists",
    content: { "application/json": { schema: ErrorSchema } },
  },
  422: {
    description: "Validation failed",
    content: { "application/json": { schema: ValidationErrorSchema } },
  },
  429: {
    description: "Rate limit exceeded",
    content: { "application/json": { schema: RateLimitErrorSchema } },
  },
  500: {
    description: "Internal server error",
    content: { "application/json": { schema: ErrorSchema } },
  },
} as const;

/** Pick specific error codes from commonErrorResponses. */
export function errorResponses<K extends keyof typeof commonErrorResponses>(
  ...codes: K[]
): Pick<typeof commonErrorResponses, K> {
  const result = {} as any;
  for (const code of codes) result[code] = commonErrorResponses[code];
  return result;
}

/** Shorthand for a JSON response schema in createRoute(). */
export function jsonContent<T extends z.ZodTypeAny>(schema: T, description = "Success") {
  return {
    description,
    content: { "application/json": { schema } } as const,
  };
}
