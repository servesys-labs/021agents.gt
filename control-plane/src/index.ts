/**
 * AgentOS Control-Plane Worker — main entry point.
 *
 * Hono HTTP framework + CF Queue consumer + Cron Triggers.
 * All portal API endpoints except agent runtime execution.
 */
import { cors } from "hono/cors";
import type { Env } from "./env";
import type { CurrentUser } from "./auth/types";
import { errorHandler } from "./middleware/error-handler";
import { authMiddleware } from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { createApp } from "./lib/openapi";

// Route imports (added as phases are implemented)
import { authRoutes } from "./routes/auth";
import { apiKeyRoutes } from "./routes/api-keys";
import { agentRoutes } from "./routes/agents";
import { evalRoutes } from "./routes/eval";
import { evolveRoutes } from "./routes/evolve";
import { workflowRoutes } from "./routes/workflows";
import { securityRoutes } from "./routes/security";
import { redteamRoutes } from "./routes/redteam";
import { issueRoutes } from "./routes/issues";
import { conversationIntelRoutes } from "./routes/conversation-intel";
import { billingRoutes } from "./routes/billing";
import { stripeRoutes } from "./routes/stripe";
import { creditRoutes } from "./routes/credits";
import { sessionRoutes } from "./routes/sessions";
import { observabilityRoutes } from "./routes/observability";
import { opsObservabilityRoutes } from "./routes/ops-observability";
import { memoryRoutes } from "./routes/memory";
import { ragRoutes } from "./routes/rag";
import { projectRoutes } from "./routes/projects";
import { orgRoutes } from "./routes/orgs";
import { releaseRoutes } from "./routes/releases";
import { goldImageRoutes } from "./routes/gold-images";
import { policyRoutes } from "./routes/policies";
import { sloRoutes } from "./routes/slos";
import { secretRoutes } from "./routes/secrets";
import { scheduleRoutes } from "./routes/schedules";
import { webhookRoutes } from "./routes/webhooks";
import { jobRoutes } from "./routes/jobs";
import { mcpControlRoutes } from "./routes/mcp-control";
import { connectorRoutes } from "./routes/connectors";
import { chatPlatformRoutes } from "./routes/chat-platforms";
import { voiceRoutes } from "./routes/voice";
import { skillRoutes } from "./routes/skills";
import { toolRoutes } from "./routes/tools";
import { auditRoutes } from "./routes/audit";
import { retentionRoutes } from "./routes/retention";
import { complianceRoutes } from "./routes/compliance";
import { configRoutes } from "./routes/config";
import { deployRoutes } from "./routes/deploy";
import { autoresearchRoutes } from "./routes/autoresearch";
import { edgeIngestRoutes } from "./routes/edge-ingest";
import { runtimeProxyRoutes } from "./routes/runtime-proxy";
import { gpuRoutes } from "./routes/gpu";
import { middlewareStatusRoutes } from "./routes/middleware-status";
import { compareRoutes } from "./routes/compare";
import { sandboxRoutes } from "./routes/sandbox";
import { plansRoutes } from "./routes/plans";
import { marketplaceRoutes } from "./routes/marketplace";
import { referralRoutes } from "./routes/referrals";
import { guardrailRoutes } from "./routes/guardrails";
import { dlpRoutes } from "./routes/dlp";
import { pipelineRoutes } from "./routes/pipelines";
import { feedbackRoutes } from "./routes/feedback";
import { codemodeRoutes } from "./routes/codemode";
import { a2aRoutes } from "./routes/a2a";
import { dashboardRoutes } from "./routes/dashboard";
import { trainingRoutes } from "./routes/training";
import { domainRoutes } from "./routes/domains";
import { publicAgentRoutes } from "./routes/public-api";
import { hostnameMiddleware } from "./middleware/hostname";
import { openapiRoutes } from "./routes/openapi";
import { widgetServeRoutes } from "./routes/widget-serve";
import { apiKeyRateLimitMiddleware } from "./middleware/api-key-rate-limit";
import { ipAllowlistMiddleware } from "./middleware/ip-allowlist";
import { apiAuditLogMiddleware } from "./middleware/api-audit-log";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import { endUserTokenRoutes } from "./routes/end-user-tokens";
import { batchApiRoutes } from "./routes/batch-api";
import { alertRoutes } from "./routes/alerts";
import { sessionMgmtRoutes } from "./routes/session-mgmt";
import { securityEventRoutes } from "./routes/security-events";
import { secretsRotationRoutes } from "./routes/secrets-rotation";
import { mfaEnforcementMiddleware } from "./middleware/mfa-enforcement";

const app = createApp();

// ── Global middleware ────────────────────────────────────────────────────
app.use("*", securityHeadersMiddleware);
app.use("*", cors({
  origin: (origin) => {
    const allowed = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5173,https://app.oneshots.co").split(",");
    if (!origin || allowed.includes(origin) || allowed.includes("*")) return origin;
    // Allow any *.oneshots.co subdomain
    if (origin && /^https:\/\/[a-z0-9-]+\.oneshots\.co$/.test(origin)) return origin;
    // Allow any *.agentos.dev subdomain (custom org domains)
    if (origin && /^https:\/\/[a-z0-9-]+\.agentos\.dev$/.test(origin)) return origin;
    // Allow any *.servesys.workers.dev subdomain (internal services)
    if (origin && /^https:\/\/[a-z0-9-]+\.servesys\.workers\.dev$/.test(origin)) return origin;
    return null;
  },
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
  exposeHeaders: ["X-Request-ID"],
  maxAge: 86400,
}));
app.use("*", errorHandler);
app.use("*", hostnameMiddleware);
app.use("*", rateLimitMiddleware);
app.use("*", authMiddleware);
app.use("*", ipAllowlistMiddleware);
app.use("*", apiKeyRateLimitMiddleware);
app.use("*", mfaEnforcementMiddleware);
app.use("*", apiAuditLogMiddleware);

// Hono-level error handler (catches errors that bypass middleware)
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : "Internal server error";

  console.error(`[onError] ${c.req.method} ${c.req.path}: ${message}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  return c.json({ error: message }, 500);
});

// ── Health ───────────────────────────────────────────────────────────────
app.get("/health", (c) =>
  c.json({ status: "ok", version: "0.2.0", service: "control-plane", timestamp: Date.now() }),
);
app.get("/api/v1/health", (c) =>
  c.json({ status: "ok", version: "0.2.0", service: "control-plane", timestamp: Date.now() }),
);

// ── API Routes ───────────────────────────────────────────────────────────
// Auth (public + protected)
app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/api-keys", apiKeyRoutes);

// Core agent lifecycle
app.route("/api/v1/agents", agentRoutes);
// Eval, evolve, workflows
app.route("/api/v1/eval", evalRoutes);
app.route("/api/v1/evolve", evolveRoutes);
app.route("/api/v1/workflows", workflowRoutes);

// Governance, security, compliance
app.route("/api/v1/security", securityRoutes);
app.route("/api/v1/redteam", redteamRoutes);
app.route("/api/v1/issues", issueRoutes);
app.route("/api/v1/intelligence", conversationIntelRoutes);
app.route("/api/v1/gold-images", goldImageRoutes);
app.route("/api/v1/policies", policyRoutes);
app.route("/api/v1/slos", sloRoutes);

// Billing
app.route("/api/v1/billing", billingRoutes);
app.route("/api/v1/stripe", stripeRoutes);
app.route("/api/v1/credits", creditRoutes);

// Sessions + observability
app.route("/api/v1/sessions", sessionRoutes);
app.route("/api/v1/observability", observabilityRoutes);
app.route("/api/v1/ops", opsObservabilityRoutes);

// Memory + RAG
app.route("/api/v1/memory", memoryRoutes);
app.route("/api/v1/rag", ragRoutes);

// Projects + orgs
app.route("/api/v1/projects", projectRoutes);
app.route("/api/v1/orgs", orgRoutes);
// Backward-compatible alias used by some portal flows.
app.route("/api/v1/org", orgRoutes);

// Releases
app.route("/api/v1/releases", releaseRoutes);

// Secrets
app.route("/api/v1/secrets", secretRoutes);

// Schedules, webhooks, jobs
app.route("/api/v1/schedules", scheduleRoutes);
app.route("/api/v1/webhooks", webhookRoutes);
app.route("/api/v1/jobs", jobRoutes);

// Integrations
app.route("/api/v1/mcp", mcpControlRoutes);
app.route("/api/v1/connectors", connectorRoutes);
app.route("/api/v1/chat", chatPlatformRoutes);
app.route("/api/v1/voice", voiceRoutes);

// Tools + skills
app.route("/api/v1/skills", skillRoutes);
app.route("/api/v1/tools", toolRoutes);

// Audit + retention
app.route("/api/v1/audit", auditRoutes);
app.route("/api/v1/retention", retentionRoutes);
app.route("/api/v1/compliance", complianceRoutes);

// Config, deploy, autoresearch
app.route("/api/v1/config", configRoutes);
app.route("/api/v1/deploy", deployRoutes);
app.route("/api/v1/autoresearch", autoresearchRoutes);

// Edge ingest + runtime proxy + GPU
app.route("/api/v1/edge-ingest", edgeIngestRoutes);
app.route("/api/v1/runtime-proxy", runtimeProxyRoutes);
app.route("/api/v1/gpu", gpuRoutes);

// Middleware status
app.route("/api/v1/middleware", middlewareStatusRoutes);

// Compare + sandbox
app.route("/api/v1/compare", compareRoutes);
app.route("/api/v1/sandbox", sandboxRoutes);

// LLM plans (built-in catalog + org-scoped custom plans)
app.route("/api/v1/plans", plansRoutes);

// Agent Marketplace (publish, discover, rate, feature)
app.route("/api/v1/marketplace", marketplaceRoutes);

// Referral Program (codes, stats, earnings)
app.route("/api/v1/referrals", referralRoutes);

// Components (reusable prompts, tool sets)
// app.route("/api/v1/components", componentRoutes); // removed

// Guardrails + DLP
app.route("/api/v1/guardrails", guardrailRoutes);
app.route("/api/v1/dlp", dlpRoutes);

// Pipelines (streams, sinks, SQL transforms)
app.route("/api/v1/pipelines", pipelineRoutes);

// Feedback (user thumbs up/down loop)
app.route("/api/v1/feedback", feedbackRoutes);

// Codemode (snippets, execution, templates)
app.route("/api/v1/codemode", codemodeRoutes);

// Dashboard (aggregated stats + activity)
app.route("/api/v1/dashboard", dashboardRoutes);

// Training (Agent Lightning-style training loop)
app.route("/api/v1/training", trainingRoutes);

// Custom domains management
app.route("/api/v1/domains", domainRoutes);

// ── Public Agent API (for SDK / widget consumers) ───────────────────────
// These routes are accessed via custom org domains (acme.agentos.dev)
// or directly with API key auth. They proxy to the runtime worker.
app.route("/v1", publicAgentRoutes);
app.route("/v1", batchApiRoutes);
app.route("/v1", openapiRoutes);

// End-user token management (SaaS multi-tenant)
app.route("/api/v1/end-user-tokens", endUserTokenRoutes);

// Ops observability + Alerts (already registered above — skip duplicates)
app.route("/api/v1/alerts", alertRoutes);
app.route("/api/v1/session-management", sessionMgmtRoutes);
app.route("/api/v1/security-events", securityEventRoutes);
app.route("/api/v1/secrets-rotation", secretsRotationRoutes);

// Widget script serving (public, no auth)
app.route("/", widgetServeRoutes);

// A2A (Agent-to-Agent) protocol endpoints
app.route("/", a2aRoutes);

// ── Auto-generated OpenAPI spec + Scalar docs ────────────────────────────
app.doc("/api/v1/_openapi-raw.json", {
  openapi: "3.0.3",
  info: {
    title: "AgentOS API",
    version: "1.0.0",
    description:
      "Full API for the AgentOS control plane — agents, eval, auth, governance, and more.\n\n" +
      "Authenticate with `Authorization: Bearer ak_...`",
    contact: { name: "AgentOS", url: "https://agentos.dev" },
  },
  servers: [
    { url: "https://api.oneshots.co", description: "Production" },
  ],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: "Auth", description: "Authentication and user management" },
    { name: "Agents", description: "Agent CRUD, configuration, and lifecycle" },
    { name: "Runtime Proxy", description: "Forward execution requests to runtime worker" },
    { name: "Sessions", description: "Session and trace management" },
    { name: "Eval", description: "Evaluation datasets, runs, and experiments" },
    { name: "Issues", description: "Issue detection, triage, and auto-fix" },
    { name: "Security", description: "OWASP scanning, risk profiles, AIVSS" },
    { name: "Redteam", description: "Red team probes and security testing" },
    { name: "Observability", description: "Traces, spans, annotations, meta-reports" },
    { name: "Ops Observability", description: "Operational monitoring and incidents" },
    { name: "ConversationIntel", description: "Conversation quality and sentiment" },
    { name: "Intelligence", description: "Cross-agent intelligence dashboard" },
    { name: "Billing", description: "Usage, costs, and invoices" },
    { name: "Stripe", description: "Stripe payment integration" },
    { name: "Evolve", description: "Agent evolution proposals and ledger" },
    { name: "Workflows", description: "Multi-agent DAG workflows" },
    { name: "Releases", description: "Release channels and canary deployments" },
    { name: "Gold Images", description: "Compliance baselines and drift detection" },
    { name: "Compliance", description: "Compliance policies and checks" },
    { name: "Policies", description: "Governance policy templates" },
    { name: "SLOs", description: "Service level objectives" },
    { name: "Guardrails", description: "PII detection, prompt injection, output safety" },
    { name: "DLP", description: "Data loss prevention classifications" },
    { name: "Feedback", description: "User feedback collection and analytics" },
    { name: "Memory", description: "Agent memory (episodic, semantic, procedural)" },
    { name: "RAG", description: "Document ingestion and knowledge base" },
    { name: "Pipelines", description: "Data pipeline streams, sinks, and transforms" },
    { name: "Codemode", description: "Code snippets, execution, and templates" },
    { name: "Components", description: "Reusable agent components" },
    { name: "Connectors", description: "Pipedream connectors and OAuth" },
    { name: "MCP", description: "MCP server registry" },
    { name: "Skills", description: "Skill library management" },
    { name: "Tools", description: "Tool registry" },
    { name: "Schedules", description: "Cron-based scheduled runs" },
    { name: "Jobs", description: "Async job queue and dead letter" },
    { name: "Webhooks", description: "Webhook CRUD and delivery" },
    { name: "Alerts", description: "Alert rules and history" },
    { name: "Orgs", description: "Organization and team management" },
    { name: "Projects", description: "Project hierarchy and canvas" },
    { name: "API Keys", description: "API key lifecycle" },
    { name: "Secrets", description: "Encrypted secrets vault" },
    { name: "Secrets Rotation", description: "Automated secret rotation" },
    { name: "Retention", description: "Data retention policies" },
    { name: "Audit", description: "Tamper-evident audit log" },
    { name: "Deploy", description: "Agent deployment management" },
    { name: "Config", description: "Platform configuration" },
    { name: "AutoResearch", description: "Autonomous improvement loops" },
    { name: "Compare", description: "A/B agent comparison" },
    { name: "Sandbox", description: "Code execution sandbox" },
    { name: "GPU", description: "GPU endpoint provisioning" },
    { name: "Voice", description: "Voice/Vapi integration" },
    { name: "Chat Platforms", description: "Telegram, Discord integration" },
    { name: "Plans", description: "LLM routing plans" },
    { name: "Middleware", description: "Middleware chain status" },
    { name: "Edge Ingest", description: "Telemetry ingestion from runtime" },
    { name: "Batch API", description: "Batch operations" },
    { name: "Dashboard", description: "Dashboard aggregations" },
    { name: "Domains", description: "Custom domain management" },
    { name: "End User Tokens", description: "End-user authentication tokens" },
    { name: "Session Management", description: "Session lifecycle" },
    { name: "Security Events", description: "Security event log" },
    { name: "Public API", description: "Public-facing API endpoints" },
    { name: "A2A", description: "Agent-to-Agent protocol" },
    { name: "Training", description: "Agent training loop — eval, optimize, version, rollback" },
    { name: "System", description: "Health and system status" },
    { name: "Widget", description: "Embeddable chat widget" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "API Key or JWT",
        description: "API key (ak_...) or JWT token from /api/v1/auth/login",
      },
    },
  },
} as any);

// Post-process the generated spec to fix OAS 3.1 compliance issues
app.get("/api/v1/openapi.json", async (c) => {
  // Get the auto-generated spec and post-process for OAS 3.1 compliance
  const fakeReq = new Request("http://internal/api/v1/_openapi-raw.json");
  const rawResp = await app.fetch(fakeReq, c.env, c.executionCtx as any);
  const spec = await rawResp.json() as Record<string, any>;

  // Fix: convert nullable to OAS 3.1 format (type array with "null")
  // Fix: convert exclusiveMinimum boolean to number
  // Fix: add operationId where missing
  function fixSchema(obj: any, path = ""): void {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { obj.forEach((v, i) => fixSchema(v, `${path}[${i}]`)); return; }

    // OAS 3.0: nullable without type is invalid — add type: "object"
    if (obj.nullable === true && !obj.type) {
      obj.type = "object";
    }

    // OAS 3.0: exclusiveMinimum must be boolean (Zod sometimes emits number)
    if (typeof obj.exclusiveMinimum === "number") {
      obj.minimum = obj.exclusiveMinimum;
      obj.exclusiveMinimum = true;
    }
    if (typeof obj.exclusiveMaximum === "number") {
      obj.maximum = obj.exclusiveMaximum;
      obj.exclusiveMaximum = true;
    }

    for (const key of Object.keys(obj)) fixSchema(obj[key], `${path}.${key}`);
  }

  // Add operationId to operations that don't have one
  let opCounter = 0;
  const paths = (spec as any).paths || {};
  for (const [pathStr, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== "object") continue;
    for (const [method, op] of Object.entries(methods as Record<string, any>)) {
      if (!["get", "post", "put", "delete", "patch"].includes(method)) continue;
      if (!op.operationId) {
        // Generate: GET /api/v1/agents → getAgents, POST /api/v1/agents → postAgents
        const parts = pathStr.replace(/^\/api\/v1\//, "").replace(/\{[^}]+\}/g, "ById").split("/").filter(Boolean);
        const name = parts.map((p, i) => i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)).join("");
        op.operationId = `${method}${name.charAt(0).toUpperCase() + name.slice(1)}_${opCounter++}`;
      }
      if (!op.description) {
        op.description = op.summary || `${method.toUpperCase()} ${pathStr}`;
      }
    }
  }

  fixSchema(spec);

  // Inject securitySchemes (app.doc() doesn't merge components properly)
  if (!spec.components) spec.components = {};
  if (!spec.components.securitySchemes) {
    spec.components.securitySchemes = {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "API Key or JWT",
        description: "API key (ak_...) or JWT token from /api/v1/auth/login",
      },
    };
  }

  return c.json(spec as any);
});

app.get("/api/v1/docs", (c) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>AgentOS API Reference</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="/api/v1/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
  return c.html(html);
});

// ── Export ────────────────────────────────────────────────────────────────
export default {
  fetch: app.fetch,

  // Queue consumer — async job processing
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const { getDb, getDbForOrg } = await import("./db/client");
    const { hasCredits: hasCreditsCheck, deductCredits: deductCreditsForOrg } = await import("./logic/credits");

    for (const msg of batch.messages) {
      const job = msg.body as { type: string; payload: Record<string, unknown> };
      try {
        const sql = await getDb(env.HYPERDRIVE);
        const now = new Date().toISOString();

        if (job.type === "agent_run") {
          // Dispatch agent run to runtime worker
          const { agent_name, task, org_id, project_id } = job.payload;
          const resp = await env.RUNTIME.fetch(
            new Request("https://runtime/run", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {}),
              },
              body: JSON.stringify({ input: task, agent_name, org_id, project_id }),
            }),
          );
          const result = await resp.json() as Record<string, unknown>;

          // Update job status in DB
          await sql`
            UPDATE job_queue SET status = 'completed', result_json = ${JSON.stringify(result)}, completed_at = ${now}
            WHERE job_id = ${String(job.payload.job_id || "")}
          `.catch(() => {});
        } else if (job.type === "webhook_delivery") {
          // Deliver a webhook with retry
          const { deliverWebhook } = await import("./logic/webhook-delivery");
          const p = job.payload;
          const delivered = await deliverWebhook(
            String(p.url), String(p.body), String(p.secret || ""),
            sql, String(p.webhook_id || ""),
          );
          if (!delivered) {
            // Retry via queue (msg.retry())
            msg.retry();
            continue;
          }
        } else if (job.type === "batch_run") {
          // Process a batch of agent runs
          const batchId = String(job.payload.batch_id || "");
          const orgId = String(job.payload.org_id || "");
          const agentName = String(job.payload.agent_name || "");

          await sql`UPDATE batch_jobs SET status = 'running' WHERE batch_id = ${batchId}`.catch(() => {});

          const tasks = await sql`
            SELECT task_id, task_index, input, system_prompt, response_format, response_schema
            FROM batch_tasks WHERE batch_id = ${batchId} AND status = 'pending'
            ORDER BY task_index ASC
          `;

          let completedCount = 0;
          let failedCount = 0;

          for (const task of tasks) {
            // Credit gate: check before each task
            try {
              const creditSql = await getDbForOrg(env.HYPERDRIVE, orgId);
              const hasEnough = await hasCreditsCheck(creditSql, orgId, 1);
              if (!hasEnough) {
                // Mark this and all remaining tasks as failed
                await sql`
                  UPDATE batch_tasks SET status = 'failed', error = 'insufficient_credits'
                  WHERE batch_id = ${batchId} AND status = 'pending'
                `.catch(() => {});
                await sql`UPDATE batch_tasks SET status = 'failed', error = 'insufficient_credits' WHERE task_id = ${task.task_id}`.catch(() => {});
                failedCount += tasks.length - completedCount - failedCount;
                break;
              }
            } catch {
              // If credit check fails, allow the run
            }

            try {
              await sql`UPDATE batch_tasks SET status = 'running' WHERE task_id = ${task.task_id}`;
              const runtimeBody: Record<string, unknown> = {
                input: task.input, agent_name: agentName, org_id: orgId, project_id: "", channel: "batch_api",
              };
              if (task.system_prompt) runtimeBody.system_prompt = task.system_prompt;
              if (task.response_format) runtimeBody.response_format = task.response_format;
              if (task.response_schema) {
                try { runtimeBody.response_schema = typeof task.response_schema === "string" ? JSON.parse(task.response_schema) : task.response_schema; } catch {}
              }

              const resp = await env.RUNTIME.fetch(
                new Request("https://runtime/run", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", ...(env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {}) },
                  body: JSON.stringify(runtimeBody),
                }),
              );
              const result = await resp.json() as Record<string, unknown>;
              await sql`
                UPDATE batch_tasks SET status = 'completed', output = ${String(result.output || "")},
                  session_id = ${String(result.session_id || "")},
                  cost_usd = ${Number(result.cost_usd || 0)}, latency_ms = ${Number(result.latency_ms || 0)}
                WHERE task_id = ${task.task_id}
              `;
              completedCount++;

              // Fire-and-forget credit deduction based on actual cost
              try {
                const costUsd = Number(result.cost_usd || 0);
                const deductSql = await getDbForOrg(env.HYPERDRIVE, orgId);
                deductCreditsForOrg(deductSql, orgId, costUsd, `Batch run: ${agentName}`, agentName, String(result.session_id || "")).catch(() => {});
              } catch {}
            } catch (taskErr) {
              await sql`UPDATE batch_tasks SET status = 'failed', error = ${String(taskErr)} WHERE task_id = ${task.task_id}`.catch(() => {});
              failedCount++;
            }
          }

          await sql`
            UPDATE batch_jobs SET status = 'completed', completed_tasks = ${completedCount}, failed_tasks = ${failedCount}, completed_at = ${now}
            WHERE batch_id = ${batchId}
          `.catch(() => {});

          // Deliver callback webhook if configured
          const batchRow = await sql`SELECT callback_url, callback_secret FROM batch_jobs WHERE batch_id = ${batchId}`.catch(() => []);
          if (batchRow.length > 0 && batchRow[0].callback_url) {
            const { deliverWebhook } = await import("./logic/webhook-delivery");
            await deliverWebhook(
              batchRow[0].callback_url,
              JSON.stringify({ event: "batch.completed", timestamp: now, data: { batch_id: batchId, agent_name: agentName, completed_tasks: completedCount, failed_tasks: failedCount } }),
              batchRow[0].callback_secret || "", sql,
            ).catch(() => {});
          }
        } else if (job.type === "security_scan") {
          // Dispatch security scan
          const { agent_name, org_id } = job.payload;
          const { scanConfig: scanAgentConfig } = await import("./logic/security-scanner");
          const agentRows = await sql`
            SELECT config_json FROM agents WHERE name = ${String(agent_name)} AND org_id = ${String(org_id)} LIMIT 1
          `;
          if (agentRows.length > 0) {
            let config: Record<string, unknown> = {};
            try { config = JSON.parse(String(agentRows[0].config_json || "{}")); } catch {}
            const scanResult = scanAgentConfig(String(agent_name), config, crypto.randomUUID().slice(0, 12));
            await sql`
              INSERT INTO security_scans (scan_id, org_id, agent_name, scan_type, risk_score, risk_level, total_probes, passed, failed, created_at)
              VALUES (${crypto.randomUUID().slice(0, 12)}, ${String(org_id)}, ${String(agent_name)}, 'config',
                      ${scanResult.risk_score}, ${scanResult.risk_level}, ${scanResult.total_probes},
                      ${scanResult.passed}, ${scanResult.failed}, ${now})
            `.catch(() => {});
          }
        } else if (job.type === "eval_run") {
          // Forward eval to runtime
          const resp = await env.RUNTIME.fetch(
            new Request("https://runtime/api/v1/eval/run", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {}),
              },
              body: JSON.stringify(job.payload),
            }),
          );
          await resp.json(); // consume response
        } else if (job.type === "evolution_analysis") {
          // Async quality-drop analysis — dispatched from cron
          const data = msg.body as { agent_name: string; org_id: string; days?: number };
          const agentName = String(data.agent_name);
          const orgId = String(data.org_id);
          const days = Number(data.days) || 7;

          const { analyzeSessionRecords: analyze, generateProposals: genProposals } = await import("./logic/evolution-analyzer");

          const agentRows = await sql`
            SELECT config_json FROM agents WHERE name = ${agentName} AND org_id = ${orgId} AND is_active = 1 LIMIT 1
          `;
          if (agentRows.length > 0) {
            let agentConfig: Record<string, unknown> = {};
            try { agentConfig = JSON.parse(String(agentRows[0].config_json || "{}")); } catch {}

            const since = Date.now() / 1000 - days * 86400;
            const sessions = await sql`
              SELECT session_id, agent_name, status, cost_total_usd, wall_clock_seconds, step_count, action_count, created_at
              FROM sessions WHERE agent_name = ${agentName} AND org_id = ${orgId} AND created_at > ${since}
              ORDER BY created_at DESC LIMIT 200
            `;

            const records = sessions.map((s: any) => ({
              session_id: String(s.session_id), agent_name: String(s.agent_name),
              status: String(s.status || "unknown"), stop_reason: String(s.status || "unknown"),
              cost_total_usd: Number(s.cost_total_usd || 0), wall_clock_seconds: Number(s.wall_clock_seconds || 0),
              step_count: Number(s.step_count || 0), action_count: Number(s.action_count || 0),
              created_at: Number(s.created_at || 0), tool_calls: [] as any[], errors: [] as any[],
            }));

            const availableTools = Array.isArray(agentConfig.tools) ? agentConfig.tools as string[] : [];
            const report = analyze(agentName, records, availableTools, days);
            const proposals = genProposals(report, agentConfig);
            const nowTs = Date.now() / 1000;

            for (const proposal of proposals) {
              await sql`
                INSERT INTO evolution_proposals (proposal_id, agent_name, org_id, title, rationale, category, priority, config_diff_json, evidence_json, status, created_at)
                VALUES (${proposal.id}, ${agentName}, ${orgId}, ${proposal.title}, ${proposal.rationale}, ${proposal.category}, ${proposal.priority}, ${JSON.stringify(proposal.modification)}, ${JSON.stringify(proposal.evidence)}, 'pending', ${nowTs})
                ON CONFLICT (proposal_id) DO UPDATE SET title = EXCLUDED.title, priority = EXCLUDED.priority
              `.catch(() => {});
            }

            await sql`
              INSERT INTO evolution_reports (agent_name, org_id, report_json, session_count, created_at)
              VALUES (${agentName}, ${orgId}, ${JSON.stringify(report)}, ${records.length}, ${nowTs})
            `.catch(() => {});

            console.log(`[queue] Evolution analysis for ${agentName}: ${records.length} sessions, ${proposals.length} proposals`);
          }
        } else if (job.type === "training_step") {
          // Advance one training iteration — called by cron or auto-step
          const jobId = String(job.payload.job_id || "");
          const orgId = String(job.payload.org_id || "");
          if (!jobId || !orgId) { msg.ack(); continue; }

          // Check job is still running
          const jobRows = await sql`
            SELECT status, current_iteration, max_iterations FROM training_jobs
            WHERE job_id = ${jobId} AND org_id = ${orgId}
          `;
          if (jobRows.length === 0 || jobRows[0].status !== "running") {
            msg.ack();
            continue;
          }

          // Call the training step endpoint internally
          try {
            const stepResp = await app.fetch(
              new Request(`https://internal/api/v1/training/jobs/${jobId}/step`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${env.SERVICE_TOKEN}`,
                },
              }),
              env,
            );
            const stepResult = await stepResp.json() as Record<string, unknown>;

            // If training should continue, enqueue next step
            if (stepResult.should_continue) {
              await env.JOB_QUEUE.send({
                type: "training_step",
                payload: { job_id: jobId, org_id: orgId },
              });
            }

            console.log(`[queue] Training step for job ${jobId}: iteration ${stepResult.iteration_number}, continue=${stepResult.should_continue}`);
          } catch (stepErr) {
            console.error(`[queue] Training step failed for job ${jobId}:`, stepErr);
            // Mark job as failed
            await sql`
              UPDATE training_jobs SET status = 'failed', completed_at = ${now}
              WHERE job_id = ${jobId}
            `.catch(() => {});
          }
        }

        msg.ack();
      } catch (err) {
        console.error(`[queue] Job ${job.type} failed:`, err);
        // Update job status to failed
        try {
          const sql = await getDb(env.HYPERDRIVE);
          await sql`
            UPDATE job_queue SET status = 'failed', error = ${String(err)}, completed_at = ${new Date().toISOString()}
            WHERE job_id = ${String(job.payload.job_id || "")}
          `;
        } catch {}
        msg.retry();
      }
    }
  },

  // Cron Triggers — scheduled agent runs + data retention
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const { getDb } = await import("./db/client");
    const sql = await getDb(env.HYPERDRIVE);
    const now = new Date().toISOString();
    const nowEpoch = Math.floor(Date.now() / 1000);

    // 1. Check for due schedules
    try {
      const dueSchedules = await sql`
        SELECT id, agent_name, task, org_id, cron_expression
        FROM schedules
        WHERE enabled = true AND (next_run_at IS NULL OR next_run_at <= ${now})
        LIMIT 10
      `;

      for (const schedule of dueSchedules) {
        // Dispatch each due schedule as a job via the queue
        try {
          await env.JOB_QUEUE.send({
            type: "agent_run",
            payload: {
              agent_name: schedule.agent_name,
              task: schedule.task,
              org_id: schedule.org_id,
              schedule_id: schedule.id,
            },
          });

          // Update schedule: increment run_count, set last_run, compute next_run
          await sql`
            UPDATE schedules
            SET run_count = run_count + 1,
                last_run_at = ${now},
                last_status = 'dispatched',
                next_run_at = ${nowEpoch + 60}
            WHERE id = ${schedule.id}
          `;
        } catch (err) {
          await sql`
            UPDATE schedules SET last_status = 'error', last_error = ${String(err)}
            WHERE id = ${schedule.id}
          `.catch(() => {});
        }
      }
    } catch (err) {
      console.error("[cron] Schedule check failed:", err);
    }

    // 2. Evolution scheduling — run analyzer for due schedules
    try {
      const dueEvolutionSchedules = await sql`
        SELECT id, agent_name, org_id, interval_days, min_sessions, last_run_at
        FROM evolution_schedules
        WHERE enabled = true AND (next_run_at IS NULL OR next_run_at <= ${now})
        LIMIT 10
      `;

      const { analyzeSessionRecords, generateProposals } = await import("./logic/evolution-analyzer");

      for (const schedule of dueEvolutionSchedules) {
        try {
          const agentName = String(schedule.agent_name);
          const orgId = String(schedule.org_id);
          const intervalDays = Number(schedule.interval_days || 7);
          const minSessions = Number(schedule.min_sessions || 10);
          const since = schedule.last_run_at ? Number(schedule.last_run_at) : nowEpoch - intervalDays * 86400;

          // Count sessions since last run
          const countRows = await sql`
            SELECT COUNT(*) as cnt FROM sessions
            WHERE agent_name = ${agentName} AND org_id = ${orgId} AND created_at > ${since}
          `;
          const sessionCount = Number(countRows[0]?.cnt || 0);

          if (sessionCount < minSessions) {
            // Not enough sessions — skip but keep the same next_run_at so we retry next cron tick
            continue;
          }

          // Fetch agent config
          const agentRows = await sql`
            SELECT config_json FROM agents
            WHERE name = ${agentName} AND org_id = ${orgId} AND is_active = true LIMIT 1
          `;
          if (agentRows.length === 0) continue;

          let agentConfig: Record<string, unknown> = {};
          try { agentConfig = JSON.parse(String(agentRows[0].config_json || "{}")); } catch {}

          // Fetch session records
          const sessions = await sql`
            SELECT session_id, agent_name, status, cost_total_usd, wall_clock_seconds,
                   step_count, action_count, created_at
            FROM sessions
            WHERE agent_name = ${agentName} AND org_id = ${orgId} AND created_at > ${since}
            ORDER BY created_at DESC LIMIT 500
          `;

          const records: Array<{
            session_id: string; agent_name: string; status: string; stop_reason: string;
            cost_total_usd: number; wall_clock_seconds: number; step_count: number;
            action_count: number; created_at: number; tool_calls: Array<{
              tool_name: string; success: boolean; error?: string; latency_ms: number; turn_number: number;
            }>; errors: Array<{
              source: "llm" | "tool" | "governance" | "timeout" | "unknown";
              message: string; tool_name?: string; turn_number: number; recoverable: boolean;
            }>; quality_score?: number; sentiment?: string; task_completed?: boolean;
          }> = [];

          for (const session of sessions) {
            const turns = await sql`
              SELECT turn_number, tool_calls_json, tool_results_json, error
              FROM turns WHERE session_id = ${session.session_id}
              ORDER BY turn_number ASC LIMIT 100
            `.catch(() => []);

            const toolCalls: Array<{ tool_name: string; success: boolean; error?: string; latency_ms: number; turn_number: number }> = [];
            const errors: Array<{ source: "llm" | "tool" | "governance" | "timeout" | "unknown"; message: string; tool_name?: string; turn_number: number; recoverable: boolean }> = [];

            for (const turn of turns) {
              let tcList: any[] = [];
              let trList: any[] = [];
              try { tcList = JSON.parse(String(turn.tool_calls_json || "[]")); } catch {}
              try { trList = JSON.parse(String(turn.tool_results_json || "[]")); } catch {}

              for (let i = 0; i < tcList.length; i++) {
                const tc = tcList[i];
                const tr = trList[i] || {};
                toolCalls.push({
                  tool_name: tc.name || tc.tool || "",
                  success: !tr.error,
                  error: tr.error || undefined,
                  latency_ms: Number(tr.latency_ms || 0),
                  turn_number: Number(turn.turn_number || 0),
                });
                if (tr.error) {
                  errors.push({
                    source: "tool",
                    message: String(tr.error).slice(0, 300),
                    tool_name: tc.name || tc.tool || "",
                    turn_number: Number(turn.turn_number || 0),
                    recoverable: true,
                  });
                }
              }

              if (turn.error) {
                errors.push({
                  source: "llm",
                  message: String(turn.error).slice(0, 300),
                  turn_number: Number(turn.turn_number || 0),
                  recoverable: false,
                });
              }
            }

            records.push({
              session_id: String(session.session_id),
              agent_name: String(session.agent_name),
              status: String(session.status || "unknown"),
              stop_reason: String(session.status || "unknown"),
              cost_total_usd: Number(session.cost_total_usd || 0),
              wall_clock_seconds: Number(session.wall_clock_seconds || 0),
              step_count: Number(session.step_count || 0),
              action_count: Number(session.action_count || 0),
              created_at: Number(session.created_at || 0),
              tool_calls: toolCalls,
              errors,
            });
          }

          // Run analyzer + generate proposals
          const availableTools = Array.isArray(agentConfig.tools) ? agentConfig.tools as string[] : [];
          const report = analyzeSessionRecords(agentName, records, availableTools, intervalDays);
          const proposals = generateProposals(report, agentConfig);

          // Store proposals
          for (const proposal of proposals) {
            await sql`
              INSERT INTO evolution_proposals (
                proposal_id, agent_name, org_id, title, rationale, category,
                priority, config_diff_json, evidence_json, status, created_at
              ) VALUES (
                ${proposal.id}, ${agentName}, ${orgId}, ${proposal.title},
                ${proposal.rationale}, ${proposal.category}, ${proposal.priority},
                ${JSON.stringify(proposal.modification)}, ${JSON.stringify(proposal.evidence)},
                'pending', ${now}
              ) ON CONFLICT (proposal_id) DO UPDATE SET
                title = EXCLUDED.title,
                rationale = EXCLUDED.rationale,
                priority = EXCLUDED.priority,
                config_diff_json = EXCLUDED.config_diff_json,
                evidence_json = EXCLUDED.evidence_json
            `.catch(() => {});
          }

          // Store report
          await sql`
            INSERT INTO evolution_reports (agent_name, org_id, report_json, session_count, created_at)
            VALUES (${agentName}, ${orgId}, ${JSON.stringify(report)}, ${records.length}, ${now})
          `.catch(() => {});

          // Update schedule: set last_run_at, compute next_run_at
          const nextRunAt = nowEpoch + intervalDays * 86400;
          await sql`
            UPDATE evolution_schedules
            SET last_run_at = ${now}, next_run_at = ${nextRunAt}
            WHERE id = ${schedule.id}
          `;

          console.log(`[cron] Evolution analysis completed for ${agentName}: ${records.length} sessions, ${proposals.length} proposals`);
        } catch (err) {
          console.error(`[cron] Evolution schedule ${schedule.id} failed:`, err);
        }
      }
    } catch (err) {
      console.error("[cron] Evolution scheduling failed:", err);
    }

    // 3. Auto-trigger evolution on quality drop (>10% success_rate decline over 7 days)
    try {
      // Get all active agents
      const activeAgents = await sql`
        SELECT DISTINCT name, org_id FROM agents WHERE is_active = true LIMIT 100
      `;

      const sevenDaysAgo = nowEpoch - 7 * 86400;
      const fourteenDaysAgo = nowEpoch - 14 * 86400;

      for (const agent of activeAgents) {
        const agentName = String(agent.name);
        const orgId = String(agent.org_id);

        // Current 7-day success rate
        const currentRows = await sql`
          SELECT COUNT(*) as total,
                 SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes
          FROM sessions
          WHERE agent_name = ${agentName} AND org_id = ${orgId}
            AND created_at > ${sevenDaysAgo}
        `;
        const currentTotal = Number(currentRows[0]?.total || 0);
        const currentSuccesses = Number(currentRows[0]?.successes || 0);

        if (currentTotal < 5) continue; // Not enough data

        const currentRate = currentSuccesses / currentTotal;

        // Prior 7-day success rate (days 8-14)
        const priorRows = await sql`
          SELECT COUNT(*) as total,
                 SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes
          FROM sessions
          WHERE agent_name = ${agentName} AND org_id = ${orgId}
            AND created_at > ${fourteenDaysAgo} AND created_at <= ${sevenDaysAgo}
        `;
        const priorTotal = Number(priorRows[0]?.total || 0);
        const priorSuccesses = Number(priorRows[0]?.successes || 0);

        if (priorTotal < 5) continue; // Not enough prior data

        const priorRate = priorSuccesses / priorTotal;
        const drop = priorRate - currentRate;

        // Trigger if success rate dropped more than 10 percentage points
        if (drop > 0.10) {
          // Check if we already ran analysis in the last 24 hours for this agent
          const recentReports = await sql`
            SELECT 1 FROM evolution_reports
            WHERE agent_name = ${agentName} AND org_id = ${orgId} AND created_at > ${nowEpoch - 86400}
            LIMIT 1
          `.catch(() => []);

          if (recentReports.length > 0) continue; // Already analyzed recently

          console.log(
            `[cron] Quality drop detected for ${agentName}: ${(priorRate * 100).toFixed(1)}% -> ${(currentRate * 100).toFixed(1)}% (drop: ${(drop * 100).toFixed(1)}pp). Auto-triggering analysis.`
          );

          // Dispatch analysis via the job queue — don't block the cron handler
          try {
            await (env as any).JOB_QUEUE.send({
              type: "evolution_analysis",
              agent_name: agentName,
              org_id: orgId,
              trigger: "quality_drop",
              drop_pp: drop,
              days: 7,
            });
            console.log(`[cron] Quality-drop analysis queued for ${agentName} (drop: ${(drop * 100).toFixed(1)}pp)`);
          } catch (err) {
            console.error(`[cron] Failed to queue quality-drop analysis for ${agentName}:`, err);
          }
        }
      }
    } catch (err) {
      console.error("[cron] Quality drop detection failed:", err);
    }

    // 3a. Expire featured marketplace listings
    try {
      await sql`UPDATE marketplace_listings SET is_featured = false, updated_at = now() WHERE featured_until < now() AND is_featured = true`;
      await sql`UPDATE marketplace_featured SET status = 'expired' WHERE ends_at < now() AND status = 'active'`;
    } catch (err) {
      console.error("[cron] Featured expiry failed:", err);
    }

    // 3b. Clean up expired idempotency cache and end-user tokens
    try {
      await sql`DELETE FROM idempotency_cache WHERE expires_at < now()`;
      await sql`DELETE FROM end_user_tokens WHERE expires_at < now() AND revoked = false`;
    } catch (err) {
      console.error("[cron] Idempotency/token cleanup failed:", err);
    }

    // 3c. Evaluate alert configs and fire webhooks for breaches
    try {
      const { evaluateAlerts } = await import("./logic/alert-evaluator");
      const orgsWithAlerts = await sql`
        SELECT DISTINCT org_id FROM alert_configs WHERE enabled = true LIMIT 50
      `;
      for (const row of orgsWithAlerts) {
        try {
          await evaluateAlerts(sql, String(row.org_id));
        } catch (err) {
          console.error(`[cron] Alert evaluation failed for org ${row.org_id}:`, err);
        }
      }
    } catch (err) {
      console.error("[cron] Alert evaluation failed:", err);
    }

    // 4. SLO breach detection — check all SLO definitions and raise issues on breach
    try {
      const sloDefs = await sql`
        SELECT id, org_id, agent_name, metric, target, window_seconds, alert_on_breach
        FROM slo_definitions
        WHERE alert_on_breach = true
        LIMIT 100
      `;

      for (const slo of sloDefs) {
        try {
          const orgId = String(slo.org_id);
          const agentName = String(slo.agent_name);
          const metric = String(slo.metric);
          const target = Number(slo.target);
          const windowSeconds = Number(slo.window_seconds || 3600);
          const windowStart = new Date(Date.now() - windowSeconds * 1000).toISOString();

          let actualValue: number | null = null;

          if (metric === "success_rate") {
            const rows = await sql`
              SELECT COUNT(*) as total,
                     SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes
              FROM sessions
              WHERE agent_name = ${agentName} AND org_id = ${orgId} AND created_at > ${windowStart}
            `;
            const total = Number(rows[0]?.total || 0);
            if (total >= 5) {
              actualValue = Number(rows[0]?.successes || 0) / total;
            }
          } else if (metric === "p99_latency" || metric === "avg_latency") {
            const rows = await sql`
              SELECT COALESCE(AVG(wall_clock_seconds), 0) as avg_latency,
                     COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY wall_clock_seconds), 0) as p99_latency
              FROM sessions
              WHERE agent_name = ${agentName} AND org_id = ${orgId} AND created_at > ${windowStart}
            `.catch(() => []);
            if (rows.length > 0) {
              actualValue = Number(rows[0]?.[metric] || 0);
            }
          } else if (metric === "eval_pass_rate") {
            const rows = await sql`
              SELECT pass_rate FROM eval_runs
              WHERE agent_name = ${agentName} AND org_id = ${orgId} AND created_at > ${windowStart}
              ORDER BY created_at DESC LIMIT 1
            `.catch(() => []);
            if (rows.length > 0) {
              actualValue = Number(rows[0]?.pass_rate || 0);
            }
          } else if (metric === "error_rate") {
            const rows = await sql`
              SELECT COUNT(*) as total,
                     SUM(CASE WHEN status IN ('error', 'timeout') THEN 1 ELSE 0 END) as errors
              FROM sessions
              WHERE agent_name = ${agentName} AND org_id = ${orgId} AND created_at > ${windowStart}
            `;
            const total = Number(rows[0]?.total || 0);
            if (total >= 5) {
              actualValue = Number(rows[0]?.errors || 0) / total;
            }
          } else if (metric === "avg_cost") {
            const rows = await sql`
              SELECT COALESCE(AVG(cost_total_usd), 0) as avg_cost
              FROM sessions
              WHERE agent_name = ${agentName} AND org_id = ${orgId} AND created_at > ${windowStart}
            `.catch(() => []);
            if (rows.length > 0) {
              actualValue = Number(rows[0]?.avg_cost || 0);
            }
          }

          if (actualValue === null) continue; // Not enough data

          // Determine breach: for "higher is better" metrics (success_rate, eval_pass_rate), breach = actual < target
          // For "lower is better" metrics (error_rate, latency, cost), breach = actual > target
          const higherIsBetter = ["success_rate", "eval_pass_rate"].includes(metric);
          const breached = higherIsBetter ? actualValue < target : actualValue > target;

          if (breached) {
            // Check for recent duplicate issue (avoid spamming)
            const recentIssues = await sql`
              SELECT 1 FROM issues
              WHERE org_id = ${orgId} AND agent_name = ${agentName}
                AND issue_type = 'slo_breach' AND metadata_json::text LIKE ${"%" + metric + "%"}
                AND created_at > ${new Date(Date.now() - windowSeconds * 1000).toISOString()}
              LIMIT 1
            `.catch(() => []);

            if (recentIssues.length > 0) continue; // Already reported within window

            const issueId = crypto.randomUUID().slice(0, 12);
            const direction = higherIsBetter ? "below" : "above";
            await sql`
              INSERT INTO issues (issue_id, org_id, agent_name, issue_type, severity, title, description, metadata_json, status, created_at)
              VALUES (
                ${issueId}, ${orgId}, ${agentName}, 'slo_breach', 'high',
                ${`SLO breach: ${metric} ${direction} target for ${agentName}`},
                ${`The ${metric} metric is ${actualValue.toFixed(4)} which is ${direction} the SLO target of ${target}. Window: ${windowSeconds}s.`},
                ${JSON.stringify({ slo_id: slo.id, metric, target, actual: actualValue, window_seconds: windowSeconds })},
                'open', ${now}
              )
            `.catch(() => {});

            console.log(`[cron] SLO breach: ${agentName} ${metric}=${actualValue.toFixed(4)} (target=${target})`);
          }
        } catch (err) {
          console.error(`[cron] SLO check for ${slo.agent_name}/${slo.metric} failed:`, err);
        }
      }
    } catch (err) {
      console.error("[cron] SLO breach detection failed:", err);
    }

    // 5. Apply retention policies (delete old data)
    try {
      const policies = await sql`
        SELECT id, resource_type, retention_days, org_id, redact_pii, archive_before_delete
        FROM retention_policies
        WHERE enabled = true
        LIMIT 20
      `;

      for (const policy of policies) {
        const cutoff = new Date(Date.now() - Number(policy.retention_days) * 86400 * 1000).toISOString();
        const orgId = String(policy.org_id || "");
        const resourceType = String(policy.resource_type);

        try {
          if (resourceType === "sessions") {
            await sql`DELETE FROM turns WHERE session_id IN (SELECT session_id FROM sessions WHERE created_at < ${cutoff} AND org_id = ${orgId})`;
            await sql`DELETE FROM sessions WHERE created_at < ${cutoff} AND org_id = ${orgId}`;
          } else if (resourceType === "billing_records") {
            await sql`DELETE FROM billing_records WHERE created_at < ${cutoff} AND org_id = ${orgId}`;
          } else if (resourceType === "audit_log") {
            await sql`DELETE FROM audit_log WHERE created_at < ${cutoff} AND org_id = ${orgId}`;
          }
        } catch {}
      }
    } catch (err) {
      console.error("[cron] Retention cleanup failed:", err);
    }

    // 5. Canary auto-promotion — check active canaries and promote/rollback based on error rates
    try {
      const canaries = await sql`
        SELECT cs.org_id, cs.agent_name, cs.primary_version, cs.canary_version, cs.canary_weight
        FROM canary_splits cs
        WHERE cs.is_active = true
      `;

      for (const canary of canaries) {
        const agentName = String(canary.agent_name);
        const orgId = String(canary.org_id);
        const since = nowEpoch - 86400; // 24-hour window

        // Compare error rates
        const primarySessions = await sql`
          SELECT COUNT(*) as total, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
          FROM sessions WHERE agent_name = ${agentName} AND org_id = ${orgId} AND created_at > ${since}
        `;
        const total = Number(primarySessions[0]?.total || 0);
        if (total < 10) continue; // Not enough data

        const errorRate = Number(primarySessions[0]?.errors || 0) / total;

        if (errorRate > 0.15) {
          // High error rate — auto-rollback canary
          await sql`UPDATE canary_splits SET is_active = false WHERE org_id = ${orgId} AND agent_name = ${agentName}`;
          await sql`
            INSERT INTO audit_log (org_id, user_id, action, resource_type, resource_id, changes_json, created_at)
            VALUES (${orgId}, 'system', 'canary.auto_rollback', 'agent', ${agentName},
                    ${JSON.stringify({ error_rate: errorRate, threshold: 0.15, canary_version: canary.canary_version })}, now())
          `.catch(() => {});
          console.log(`[cron] Auto-rollback canary for ${agentName}: error rate ${(errorRate * 100).toFixed(1)}%`);
        } else if (errorRate < 0.03) {
          // Low error rate — auto-promote canary to production
          await sql`
            INSERT INTO release_channels (org_id, agent_name, channel, version, config_json, promoted_by, promoted_at)
            VALUES (${orgId}, ${agentName}, 'production', ${String(canary.canary_version)}, '{}', 'system', now())
            ON CONFLICT (org_id, agent_name, channel) DO UPDATE SET version = ${String(canary.canary_version)}, promoted_at = now()
          `.catch(() => {});
          await sql`UPDATE canary_splits SET is_active = false WHERE org_id = ${orgId} AND agent_name = ${agentName}`;
          await sql`
            INSERT INTO audit_log (org_id, user_id, action, resource_type, resource_id, changes_json, created_at)
            VALUES (${orgId}, 'system', 'canary.auto_promote', 'agent', ${agentName},
                    ${JSON.stringify({ error_rate: errorRate, canary_version: canary.canary_version })}, now())
          `.catch(() => {});
          console.log(`[cron] Auto-promoted canary for ${agentName}: error rate ${(errorRate * 100).toFixed(1)}%`);
        }
      }
    } catch (err) {
      console.error("[cron] Canary auto-promotion failed:", err);
    }

  },
};
