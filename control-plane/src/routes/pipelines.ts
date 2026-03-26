/**
 * Pipelines router — Cloudflare Pipelines management (streams, sinks, pipelines).
 *
 * Supabase-backed CRUD with optional CF API deployment.
 * Pipeline configs stored in `pipelines` table; actual CF resources
 * created via CLOUDFLARE_API_TOKEN when developer clicks "Deploy".
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const pipelineRoutes = new Hono<R>();

// ── Helpers ──────────────────────────────────────────────────────────

function nowEpoch(): number {
  return Date.now() / 1000;
}

function shortId(): string {
  return crypto.randomUUID().slice(0, 12);
}

async function cfApi(
  env: Env,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "";
  const token = (env as unknown as Record<string, unknown>).CLOUDFLARE_API_TOKEN as string | undefined;
  if (!accountId || !token) {
    return { ok: false, error: "CF credentials not configured" };
  }
  try {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    const json = (await resp.json()) as { success?: boolean; result?: unknown; errors?: unknown[] };
    if (!json.success) {
      return { ok: false, error: JSON.stringify(json.errors ?? "Unknown CF API error").slice(0, 500) };
    }
    return { ok: true, data: json.result };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Streams ──────────────────────────────────────────────────────────

pipelineRoutes.get("/streams", requireScope("pipelines:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT id, name, description, type, config_json, status, cf_resource_id, created_at, updated_at
    FROM pipelines
    WHERE org_id = ${user.org_id} AND type = 'stream' AND status != 'deleted'
    ORDER BY created_at DESC
  `;
  return c.json({ streams: rows, total: rows.length });
});

pipelineRoutes.post("/streams", requireScope("pipelines:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);

  const id = shortId();
  const now = nowEpoch();
  const config = {
    schema: body.schema || null,
    http_enabled: body.http_enabled !== false,
    http_auth: body.http_auth !== false,
  };

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`
    INSERT INTO pipelines (id, org_id, name, description, type, config_json, status, created_at, updated_at)
    VALUES (${id}, ${user.org_id}, ${name}, ${body.description || ""}, 'stream',
            ${JSON.stringify(config)}, 'draft', ${now}, ${now})
  `;

  return c.json({ id, name, type: "stream", status: "draft", config }, 201);
});

pipelineRoutes.get("/streams/:stream_id", requireScope("pipelines:read"), async (c) => {
  const user = c.get("user");
  const streamId = c.req.param("stream_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT id, name, description, type, config_json, status, cf_resource_id, created_at, updated_at
    FROM pipelines
    WHERE id = ${streamId} AND org_id = ${user.org_id} AND type = 'stream' AND status != 'deleted'
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: "Stream not found" }, 404);
  return c.json(rows[0]);
});

pipelineRoutes.delete("/streams/:stream_id", requireScope("pipelines:write"), async (c) => {
  const user = c.get("user");
  const streamId = c.req.param("stream_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`
    UPDATE pipelines SET status = 'deleted', updated_at = ${nowEpoch()}
    WHERE id = ${streamId} AND org_id = ${user.org_id} AND type = 'stream'
  `;
  return c.json({ deleted: true, id: streamId });
});

pipelineRoutes.post("/streams/:stream_id/send", requireScope("pipelines:write"), async (c) => {
  const user = c.get("user");
  const streamId = c.req.param("stream_id");
  const body = await c.req.json();
  const events = body.events;
  if (!Array.isArray(events) || events.length === 0) {
    return c.json({ error: "events array is required" }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT cf_resource_id, config_json, status FROM pipelines
    WHERE id = ${streamId} AND org_id = ${user.org_id} AND type = 'stream' AND status != 'deleted'
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: "Stream not found" }, 404);

  const cfResourceId = String(rows[0].cf_resource_id || "");

  // If stream has a CF resource, post to the ingest endpoint
  if (cfResourceId) {
    try {
      const resp = await fetch(`https://${cfResourceId}.ingest.cloudflare.com`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(events),
      });
      if (!resp.ok) {
        return c.json({ error: `Ingest failed: ${resp.status}` }, 502);
      }
      return c.json({ sent: true, count: events.length });
    } catch (err: unknown) {
      return c.json({ error: `Ingest error: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }
  }

  // Fallback: store events in R2 for pending pipelines
  try {
    const key = `pipelines/${streamId}/${Date.now()}.jsonl`;
    const data = events.map((e: unknown) => JSON.stringify(e)).join("\n");
    await c.env.STORAGE.put(key, data);
    return c.json({ sent: true, count: events.length, storage: "r2", key });
  } catch (err: unknown) {
    return c.json({ error: `Storage error: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
});

// ── Sinks ────────────────────────────────────────────────────────────

pipelineRoutes.get("/sinks", requireScope("pipelines:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT id, name, description, type, config_json, status, cf_resource_id, created_at, updated_at
    FROM pipelines
    WHERE org_id = ${user.org_id} AND type = 'sink' AND status != 'deleted'
    ORDER BY created_at DESC
  `;
  return c.json({ sinks: rows, total: rows.length });
});

pipelineRoutes.post("/sinks", requireScope("pipelines:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);

  const sinkType = body.type || "r2_json";
  const validTypes = ["r2_iceberg", "r2_json", "r2_parquet", "vectorize", "dual"];
  if (!validTypes.includes(sinkType)) {
    return c.json({ error: `Invalid sink type. Must be one of: ${validTypes.join(", ")}` }, 400);
  }

  const id = shortId();
  const now = nowEpoch();
  const config: Record<string, unknown> = {
    sink_type: sinkType,
    bucket: body.bucket || "",
    path: body.path || "",
    format: body.format || (sinkType.startsWith("r2_") ? sinkType.replace("r2_", "") : "json"),
    compression: body.compression || "none",
    partitioning: body.partitioning || "",
  };

  // Vectorize sink config
  if (sinkType === "vectorize" || sinkType === "dual") {
    config.vectorize_index = body.vectorize_index || "agentos-knowledge";
    config.embedding_model = body.embedding_model || "@cf/baai/bge-base-en-v1.5";
    config.text_field = body.text_field || "text"; // Which event field to embed
    config.chunk_size = body.chunk_size || 500;     // Chars per chunk
    config.chunk_overlap = body.chunk_overlap || 50;
  }

  // Dual sink = R2 (structured) + Vectorize (semantic)
  if (sinkType === "dual") {
    config.r2_format = body.format || "json";
    config.r2_bucket = body.bucket || "";
    config.r2_path = body.path || "";
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`
    INSERT INTO pipelines (id, org_id, name, description, type, config_json, status, created_at, updated_at)
    VALUES (${id}, ${user.org_id}, ${name}, ${body.description || ""}, 'sink',
            ${JSON.stringify(config)}, 'draft', ${now}, ${now})
  `;

  return c.json({ id, name, type: "sink", status: "draft", config }, 201);
});

pipelineRoutes.get("/sinks/:sink_id", requireScope("pipelines:read"), async (c) => {
  const user = c.get("user");
  const sinkId = c.req.param("sink_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT id, name, description, type, config_json, status, cf_resource_id, created_at, updated_at
    FROM pipelines
    WHERE id = ${sinkId} AND org_id = ${user.org_id} AND type = 'sink' AND status != 'deleted'
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: "Sink not found" }, 404);
  return c.json(rows[0]);
});

pipelineRoutes.delete("/sinks/:sink_id", requireScope("pipelines:write"), async (c) => {
  const user = c.get("user");
  const sinkId = c.req.param("sink_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`
    UPDATE pipelines SET status = 'deleted', updated_at = ${nowEpoch()}
    WHERE id = ${sinkId} AND org_id = ${user.org_id} AND type = 'sink'
  `;
  return c.json({ deleted: true, id: sinkId });
});

// ── Pipelines ────────────────────────────────────────────────────────

pipelineRoutes.get("/", requireScope("pipelines:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT id, name, description, type, config_json, status, cf_resource_id, created_at, updated_at
    FROM pipelines
    WHERE org_id = ${user.org_id} AND type = 'pipeline' AND status != 'deleted'
    ORDER BY created_at DESC
  `;
  return c.json({ pipelines: rows, total: rows.length });
});

pipelineRoutes.post("/", requireScope("pipelines:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  if (!body.stream_id) return c.json({ error: "stream_id is required" }, 400);
  if (!body.sink_id) return c.json({ error: "sink_id is required" }, 400);
  if (!body.sql) return c.json({ error: "sql transformation query is required" }, 400);

  const id = shortId();
  const now = nowEpoch();
  const config = {
    stream_id: body.stream_id,
    sink_id: body.sink_id,
    sql: body.sql,
  };

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Validate stream and sink exist
  const streamRows = await sql`
    SELECT id, name FROM pipelines
    WHERE id = ${body.stream_id} AND org_id = ${user.org_id} AND type = 'stream' AND status != 'deleted'
    LIMIT 1
  `;
  if (streamRows.length === 0) return c.json({ error: "Stream not found" }, 404);

  const sinkRows = await sql`
    SELECT id, name FROM pipelines
    WHERE id = ${body.sink_id} AND org_id = ${user.org_id} AND type = 'sink' AND status != 'deleted'
    LIMIT 1
  `;
  if (sinkRows.length === 0) return c.json({ error: "Sink not found" }, 404);

  await sql`
    INSERT INTO pipelines (id, org_id, name, description, type, config_json, status, created_at, updated_at)
    VALUES (${id}, ${user.org_id}, ${name}, ${body.description || ""}, 'pipeline',
            ${JSON.stringify(config)}, 'draft', ${now}, ${now})
  `;

  return c.json({
    id,
    name,
    type: "pipeline",
    status: "draft",
    config,
    stream: { id: streamRows[0].id, name: streamRows[0].name },
    sink: { id: sinkRows[0].id, name: sinkRows[0].name },
  }, 201);
});

pipelineRoutes.get("/:pipeline_id", requireScope("pipelines:read"), async (c) => {
  const user = c.get("user");
  const pipelineId = c.req.param("pipeline_id");

  // Guard: skip template/stream/sink sub-routes that would match /:pipeline_id
  if (["templates", "streams", "sinks"].includes(pipelineId)) {
    return c.notFound();
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT id, name, description, type, config_json, status, cf_resource_id, created_at, updated_at
    FROM pipelines
    WHERE id = ${pipelineId} AND org_id = ${user.org_id} AND type = 'pipeline' AND status != 'deleted'
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: "Pipeline not found" }, 404);

  const pipeline = rows[0];
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(String(pipeline.config_json || "{}")); } catch {}

  // Resolve stream and sink names
  let streamName = "";
  let sinkName = "";
  if (config.stream_id) {
    const sr = await sql`SELECT name FROM pipelines WHERE id = ${String(config.stream_id)} LIMIT 1`;
    if (sr.length > 0) streamName = String(sr[0].name);
  }
  if (config.sink_id) {
    const sr = await sql`SELECT name FROM pipelines WHERE id = ${String(config.sink_id)} LIMIT 1`;
    if (sr.length > 0) sinkName = String(sr[0].name);
  }

  return c.json({
    ...pipeline,
    stream_name: streamName,
    sink_name: sinkName,
  });
});

pipelineRoutes.put("/:pipeline_id", requireScope("pipelines:write"), async (c) => {
  const user = c.get("user");
  const pipelineId = c.req.param("pipeline_id");
  const body = await c.req.json();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT config_json FROM pipelines
    WHERE id = ${pipelineId} AND org_id = ${user.org_id} AND type = 'pipeline' AND status != 'deleted'
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: "Pipeline not found" }, 404);

  let config: Record<string, unknown> = {};
  try { config = JSON.parse(String(rows[0].config_json || "{}")); } catch {}

  if (body.sql) config.sql = body.sql;
  const description = body.description !== undefined ? body.description : null;

  if (description !== null) {
    await sql`
      UPDATE pipelines SET config_json = ${JSON.stringify(config)}, description = ${description}, updated_at = ${nowEpoch()}
      WHERE id = ${pipelineId} AND org_id = ${user.org_id}
    `;
  } else {
    await sql`
      UPDATE pipelines SET config_json = ${JSON.stringify(config)}, updated_at = ${nowEpoch()}
      WHERE id = ${pipelineId} AND org_id = ${user.org_id}
    `;
  }

  return c.json({ updated: true, id: pipelineId, config });
});

pipelineRoutes.delete("/:pipeline_id", requireScope("pipelines:write"), async (c) => {
  const user = c.get("user");
  const pipelineId = c.req.param("pipeline_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`
    UPDATE pipelines SET status = 'deleted', updated_at = ${nowEpoch()}
    WHERE id = ${pipelineId} AND org_id = ${user.org_id} AND type = 'pipeline'
  `;
  return c.json({ deleted: true, id: pipelineId });
});

// ── Pipeline Templates ───────────────────────────────────────────────

const PIPELINE_TEMPLATES = [
  {
    id: "rag-knowledge",
    name: "RAG Knowledge Ingest",
    description: "Ingest documents via webhook, chunk and embed for agent RAG",
    category: "Knowledge",
    icon: "book",
    stream_config: { http_enabled: true, http_auth: true, schema: { type: "object", properties: { content: { type: "string" }, source: { type: "string" }, metadata: { type: "object" } } } },
    sink_config: { sink_type: "r2_parquet", path: "knowledge/", compression: "zstd" },
    sql: "SELECT content, source, metadata, _timestamp FROM events WHERE content IS NOT NULL AND length(content) > 0",
  },
  {
    id: "crm-events",
    name: "CRM Event Pipeline",
    description: "Capture Salesforce/HubSpot events for agent context",
    category: "CRM",
    icon: "users",
    stream_config: { http_enabled: true, http_auth: true, schema: { type: "object", properties: { event_type: { type: "string" }, user_id: { type: "string" }, data: { type: "object" } } } },
    sink_config: { sink_type: "r2_iceberg", path: "crm/events/", compression: "zstd" },
    sql: "SELECT event_type, user_id, data, _timestamp FROM events WHERE event_type IS NOT NULL",
  },
  {
    id: "log-aggregation",
    name: "Application Logs",
    description: "Stream app logs, filter errors, available to debugging agents",
    category: "Observability",
    icon: "file-text",
    stream_config: { http_enabled: true, http_auth: false },
    sink_config: { sink_type: "r2_json", path: "logs/", compression: "gzip" },
    sql: "SELECT level, message, service, trace_id, _timestamp FROM events WHERE level IN ('error', 'warn', 'fatal')",
  },
  {
    id: "agent-telemetry",
    name: "Agent Telemetry",
    description: "Collect agent runtime events for analysis",
    category: "Telemetry",
    icon: "activity",
    stream_config: { http_enabled: true, http_auth: true },
    sink_config: { sink_type: "r2_parquet", path: "telemetry/", compression: "zstd", partitioning: "daily" },
    sql: "SELECT agent_name, event_type, latency_ms, token_count, cost_usd, session_id, _timestamp FROM events",
  },
  {
    id: "webhook-events",
    name: "Webhook Events",
    description: "Receive and transform webhook payloads from any source",
    category: "Integration",
    icon: "webhook",
    stream_config: { http_enabled: true, http_auth: true },
    sink_config: { sink_type: "r2_json", path: "webhooks/", compression: "gzip" },
    sql: "SELECT source, event_type, payload, headers, _timestamp FROM events",
  },
];

pipelineRoutes.get("/templates", requireScope("pipelines:read"), async (c) => {
  return c.json({ templates: PIPELINE_TEMPLATES });
});

// ── Query ────────────────────────────────────────────────────────────

pipelineRoutes.post("/:pipeline_id/query", requireScope("pipelines:read"), async (c) => {
  const user = c.get("user");
  const pipelineId = c.req.param("pipeline_id");
  const body = await c.req.json();
  const querySql = String(body.sql || "").trim();
  const limit = Math.min(Number(body.limit) || 100, 1000);

  if (!querySql) return c.json({ error: "sql query is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT name, config_json, status FROM pipelines
    WHERE id = ${pipelineId} AND org_id = ${user.org_id} AND type = 'pipeline' AND status != 'deleted'
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: "Pipeline not found" }, 404);

  const pipelineName = String(rows[0].name);

  // Read data from R2 sink
  try {
    const listResult = await c.env.STORAGE.list({
      prefix: `pipelines/${pipelineName}/`,
      limit: 20,
    });

    if (!listResult.objects.length) {
      return c.json({ pipeline: pipelineName, records: [], total: 0, note: "No data ingested yet" });
    }

    // Read and merge recent data files
    const records: unknown[] = [];
    for (const obj of listResult.objects.slice(-5)) {
      const r2Obj = await c.env.STORAGE.get(obj.key);
      if (!r2Obj) continue;
      const text = await r2Obj.text();
      const lines = text.trim().split("\n");
      for (const line of lines) {
        try {
          records.push(JSON.parse(line));
        } catch {
          // skip malformed lines
        }
        if (records.length >= limit) break;
      }
      if (records.length >= limit) break;
    }

    return c.json({
      pipeline: pipelineName,
      records: records.slice(0, limit),
      total: records.length,
      query: querySql,
    });
  } catch (err: unknown) {
    return c.json({
      error: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
    }, 500);
  }
});

// ── Deploy (trigger CF API resource creation) ────────────────────────

pipelineRoutes.post("/:pipeline_id/deploy", requireScope("pipelines:write"), async (c) => {
  const user = c.get("user");
  const pipelineId = c.req.param("pipeline_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT id, name, type, config_json, status FROM pipelines
    WHERE id = ${pipelineId} AND org_id = ${user.org_id} AND status != 'deleted'
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: "Resource not found" }, 404);

  const resource = rows[0];
  const now = nowEpoch();

  // Mark as deploying
  await sql`
    UPDATE pipelines SET status = 'deploying', updated_at = ${now}
    WHERE id = ${pipelineId} AND org_id = ${user.org_id}
  `;

  // Attempt CF API call
  const result = await cfApi(c.env, "/pipelines", "POST", {
    name: resource.name,
    type: resource.type,
    config: JSON.parse(String(resource.config_json || "{}")),
  });

  if (result.ok) {
    const cfId = (result.data as Record<string, unknown>)?.id || "";
    await sql`
      UPDATE pipelines SET status = 'active', cf_resource_id = ${String(cfId)}, updated_at = ${nowEpoch()}
      WHERE id = ${pipelineId} AND org_id = ${user.org_id}
    `;
    return c.json({ deployed: true, id: pipelineId, cf_resource_id: cfId });
  }

  // CF API not available — mark as pending for manual deployment
  await sql`
    UPDATE pipelines SET status = 'draft', updated_at = ${nowEpoch()}
    WHERE id = ${pipelineId} AND org_id = ${user.org_id}
  `;
  return c.json({
    deployed: false,
    id: pipelineId,
    note: "CF Pipelines API unavailable. Deploy manually via wrangler CLI.",
    error: result.error,
  }, 202);
});
