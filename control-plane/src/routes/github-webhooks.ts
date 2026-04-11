/**
 * GitHub Webhook Integration — subscribe agents to repo events.
 *
 * Events supported: push, pull_request, issues, issue_comment, workflow_run.
 * Each event is routed to the configured agent via JOB_QUEUE.
 *
 * Setup: POST /github/webhooks with repo URL and secret → register webhook.
 * Receive: POST /github/webhooks/receive → validate signature → dispatch to agent.
 *
 * RLS pattern:
 *   - Register/list handlers run under withOrgDb(user.org_id) like normal.
 *   - The /receive handler is PUBLIC (no user). It takes org_id from the
 *     query string, does admin-level subscription lookup via withAdminDb
 *     (because signature verification hasn't run yet — we can't trust the
 *     caller), verifies the signature, then dispatches through the queue.
 *     After signature verification succeeds we could switch to withOrgDb,
 *     but all the DB work is already done — the subsequent queue.send()
 *     is the only side effect.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb, withAdminDb } from "../db/client";

export const githubWebhookRoutes = createOpenAPIRouter();

// ── Webhook signature verification ──
async function verifyGitHubSignature(secret: string, payload: string, signature: string): Promise<boolean> {
  if (!secret || !signature) return !secret;
  const expected = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
    return hex === expected;
  } catch { return false; }
}

// POST /github/webhooks — register a GitHub webhook subscription
const registerRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["GitHub"],
  summary: "Register a GitHub webhook subscription for an agent",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1),
            repo_url: z.string().url(),
            events: z.array(z.string()).default(["push", "pull_request", "issues"]),
            secret: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Webhook registered" },
    ...errorResponses(400, 401, 500),
  },
});

githubWebhookRoutes.openapi(registerRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const secret = body.secret || crypto.randomUUID();
    const now = new Date().toISOString();

    await sql`
      INSERT INTO github_webhook_subscriptions (org_id, agent_name, repo_url, events, secret, created_at)
      VALUES (${user.org_id}, ${body.agent_name}, ${body.repo_url}, ${JSON.stringify(body.events)}, ${secret}, ${now})
      ON CONFLICT (org_id, repo_url) DO UPDATE SET
        agent_name = EXCLUDED.agent_name, events = EXCLUDED.events, secret = EXCLUDED.secret, updated_at = NOW()
    `;

    const webhookUrl = `https://api.oneshots.co/api/v1/github/webhooks/receive?org=${encodeURIComponent(user.org_id)}`;

    return c.json({
      webhook_url: webhookUrl,
      secret,
      events: body.events,
      setup_instructions: `Add this webhook URL to your GitHub repo settings: ${webhookUrl}. Use the secret for signature verification.`,
    });
  });
});

// POST /github/webhooks/receive — receive GitHub webhook events (public, signature-verified)
githubWebhookRoutes.post("/receive", async (c) => {
  const orgId = c.req.query("org") || "";
  if (!orgId) return c.json({ error: "Missing org parameter" }, 400);

  const signature = c.req.header("X-Hub-Signature-256") || "";
  const eventType = c.req.header("X-GitHub-Event") || "";
  const rawBody = await c.req.text();

  let payload: any;
  try { payload = JSON.parse(rawBody); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const repoUrl = payload.repository?.html_url || payload.repository?.url || "";

  // Subscription lookup runs before signature verification, so we can't
  // trust the caller yet — use withAdminDb rather than withOrgDb here
  // (the query-string org_id is attacker-controllable until the HMAC
  // check below succeeds).
  const sub = await withAdminDb(c.env, async (sql) => {
    const rows = await sql`
      SELECT agent_name, events, secret FROM github_webhook_subscriptions
      WHERE org_id = ${orgId} AND (repo_url = ${repoUrl} OR repo_url LIKE ${"%" + (payload.repository?.full_name || "NONE")})
      LIMIT 1
    `;
    return rows.length > 0 ? rows[0] : null;
  });

  if (!sub) return c.json({ error: "No subscription found" }, 404);

  // Verify signature
  const valid = await verifyGitHubSignature(sub.secret, rawBody, signature);
  if (!valid) return c.json({ error: "Invalid signature" }, 401);

  // Check if event type is subscribed
  const subscribedEvents = JSON.parse(sub.events || "[]");
  if (!subscribedEvents.includes(eventType)) {
    return c.json({ skipped: true, reason: `Event ${eventType} not subscribed` });
  }

  // Build agent input from GitHub event
  const input = formatGitHubEvent(eventType, payload);

  // Dispatch to agent via queue
  const queue = (c.env as any).JOB_QUEUE;
  if (queue) {
    await queue.send({
      type: "agent_run",
      payload: {
        agent_name: sub.agent_name,
        task: input,
        org_id: orgId,
        channel: "github",
      },
    });
  }

  return c.json({ dispatched: true, agent: sub.agent_name, event: eventType });
});

// GET /github/webhooks — list subscriptions
githubWebhookRoutes.get("/", async (c) => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT agent_name, repo_url, events, created_at FROM github_webhook_subscriptions
      ORDER BY created_at DESC LIMIT 50
    `;
    return c.json({ subscriptions: rows });
  });
});

function formatGitHubEvent(eventType: string, payload: any): string {
  switch (eventType) {
    case "push":
      return `[GitHub Push] ${payload.pusher?.name || "someone"} pushed ${payload.commits?.length || 0} commit(s) to ${payload.ref || "unknown"} in ${payload.repository?.full_name || "repo"}. Latest: "${payload.head_commit?.message || ""}". Review the changes and report any issues.`;
    case "pull_request":
      return `[GitHub PR #${payload.number}] ${payload.action}: "${payload.pull_request?.title || ""}" by ${payload.pull_request?.user?.login || "unknown"} in ${payload.repository?.full_name || "repo"}. ${payload.pull_request?.body?.slice(0, 500) || ""}. Review and provide feedback.`;
    case "issues":
      return `[GitHub Issue #${payload.issue?.number}] ${payload.action}: "${payload.issue?.title || ""}" by ${payload.issue?.user?.login || "unknown"}. ${payload.issue?.body?.slice(0, 500) || ""}. Analyze and suggest a resolution.`;
    case "issue_comment":
      return `[GitHub Comment] ${payload.comment?.user?.login || "someone"} commented on #${payload.issue?.number}: "${payload.comment?.body?.slice(0, 500) || ""}". Respond if relevant.`;
    case "workflow_run":
      return `[GitHub Actions] Workflow "${payload.workflow_run?.name || "unknown"}" ${payload.workflow_run?.conclusion || payload.action} in ${payload.repository?.full_name || "repo"}. ${payload.workflow_run?.conclusion === "failure" ? "Investigate the failure." : ""}`;
    default:
      return `[GitHub ${eventType}] Event received for ${payload.repository?.full_name || "repo"}. ${JSON.stringify(payload).slice(0, 500)}`;
  }
}
