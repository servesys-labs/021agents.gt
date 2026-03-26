/**
 * AgentOS Control-Plane Worker — main entry point.
 *
 * Hono HTTP framework + CF Queue consumer + Cron Triggers.
 * All portal API endpoints except agent runtime execution.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import type { CurrentUser } from "./auth/types";
import { errorHandler } from "./middleware/error-handler";
import { authMiddleware } from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/rate-limit";

// Route imports (added as phases are implemented)
import { authRoutes } from "./routes/auth";
import { apiKeyRoutes } from "./routes/api-keys";
import { agentRoutes } from "./routes/agents";
import { graphRoutes } from "./routes/graphs";
import { evalRoutes } from "./routes/eval";
import { evolveRoutes } from "./routes/evolve";
import { workflowRoutes } from "./routes/workflows";
import { securityRoutes } from "./routes/security";
import { redteamRoutes } from "./routes/redteam";
import { issueRoutes } from "./routes/issues";
import { conversationIntelRoutes } from "./routes/conversation-intel";
import { billingRoutes } from "./routes/billing";
import { stripeRoutes } from "./routes/stripe";
import { sessionRoutes } from "./routes/sessions";
import { observabilityRoutes } from "./routes/observability";
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
import { componentRoutes } from "./routes/components";
import { guardrailRoutes } from "./routes/guardrails";
import { dlpRoutes } from "./routes/dlp";
import { pipelineRoutes } from "./routes/pipelines";
import { feedbackRoutes } from "./routes/feedback";
import { codemodeRoutes } from "./routes/codemode";
import { a2aRoutes } from "./routes/a2a";

type AppType = {
  Bindings: Env;
  Variables: { user: CurrentUser };
};

const app = new Hono<AppType>();

// ── Global middleware ────────────────────────────────────────────────────
app.use("*", cors({
  origin: (origin) => {
    const allowed = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5173").split(",");
    if (!origin || allowed.includes(origin) || allowed.includes("*")) return origin;
    return null;
  },
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));
app.use("*", errorHandler);
app.use("*", rateLimitMiddleware);
app.use("*", authMiddleware);

// ── Health ───────────────────────────────────────────────────────────────
app.get("/health", (c) =>
  c.json({ status: "ok", version: "0.2.0", service: "control-plane", timestamp: Date.now() }),
);

// ── API Routes ───────────────────────────────────────────────────────────
// Auth (public + protected)
app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/api-keys", apiKeyRoutes);

// Core agent lifecycle
app.route("/api/v1/agents", agentRoutes);
app.route("/api/v1/graphs", graphRoutes);

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

// Sessions + observability
app.route("/api/v1/sessions", sessionRoutes);
app.route("/api/v1/observability", observabilityRoutes);

// Memory + RAG
app.route("/api/v1/memory", memoryRoutes);
app.route("/api/v1/rag", ragRoutes);

// Projects + orgs
app.route("/api/v1/projects", projectRoutes);
app.route("/api/v1/orgs", orgRoutes);

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

// Components (reusable graphs, prompts, tool sets)
app.route("/api/v1/components", componentRoutes);

// Guardrails + DLP
app.route("/api/v1/guardrails", guardrailRoutes);
app.route("/api/v1/dlp", dlpRoutes);

// Pipelines (streams, sinks, SQL transforms)
app.route("/api/v1/pipelines", pipelineRoutes);

// Feedback (user thumbs up/down loop)
app.route("/api/v1/feedback", feedbackRoutes);

// Codemode (snippets, execution, templates)
app.route("/api/v1/codemode", codemodeRoutes);

// A2A (Agent-to-Agent) protocol endpoints
app.route("/", a2aRoutes);

// ── Export ────────────────────────────────────────────────────────────────
export default {
  fetch: app.fetch,

  // Queue consumer — async job processing
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const { getDb } = await import("./db/client");

    for (const msg of batch.messages) {
      const job = msg.body as { type: string; payload: Record<string, unknown> };
      try {
        const sql = await getDb(env.HYPERDRIVE);
        const now = Date.now() / 1000;

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
        }

        msg.ack();
      } catch (err) {
        console.error(`[queue] Job ${job.type} failed:`, err);
        // Update job status to failed
        try {
          const sql = await getDb(env.HYPERDRIVE);
          await sql`
            UPDATE job_queue SET status = 'failed', error = ${String(err)}, completed_at = ${Date.now() / 1000}
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
    const now = Date.now() / 1000;

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
                next_run_at = ${now + 60}
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

    // 2. Apply retention policies (delete old data)
    try {
      const policies = await sql`
        SELECT id, resource_type, retention_days, org_id, redact_pii, archive_before_delete
        FROM retention_policies
        WHERE enabled = true
        LIMIT 20
      `;

      for (const policy of policies) {
        const cutoff = now - Number(policy.retention_days) * 86400;
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
  },
};
