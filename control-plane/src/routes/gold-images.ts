/**
 * Gold images routes -- CRUD, drift detection, compliance, audit.
 * Ported from agentos/api/routers/gold_images.py.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { CurrentUser } from "../auth/types";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import {
  detectDrift,
  configHashAsync,
  complianceSummaryFromChecks,
} from "../logic/compliance-checker";

export const goldImageRoutes = createOpenAPIRouter();

// ── Helpers ──────────────────────────────────────────────────────

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Zod schemas ──────────────────────────────────────────────────

const createGoldImageSchema = z.object({
  name: z.string().min(1, "name is required"),
  config: z.record(z.unknown()).refine((v) => Object.keys(v).length > 0, "config is required"),
  description: z.string().default(""),
  version: z.string().default("1.0.0"),
  category: z.string().default("general"),
});

const updateGoldImageSchema = z.object({
  config: z.record(z.unknown()).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
});

const auditQuerySchema = z.object({
  agent_name: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const complianceChecksQuerySchema = z.object({
  agent_name: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const listQuerySchema = z.object({
  active_only: z.string().optional().default("true"),
});

const complianceCheckQuerySchema = z.object({
  image_id: z.string().optional(),
});

// ── GET / ────────────────────────────────────────────────────────

const listGoldImagesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Gold Images"],
  summary: "List gold images",
  middleware: [requireScope("gold_images:read")],
  request: { query: listQuerySchema },
  responses: {
    200: { description: "List of gold images", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

goldImageRoutes.openapi(listGoldImagesRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { active_only } = c.req.valid("query");
  const activeOnly = active_only !== "false";
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (activeOnly) {
    rows = await sql`
      SELECT image_id, name, description, version, category, config_hash,
             org_id, created_by, approved_by, approved_at, created_at
      FROM gold_images
      WHERE org_id = ${user.org_id} AND deleted_at IS NULL
      ORDER BY created_at DESC
    `;
  } else {
    rows = await sql`
      SELECT image_id, name, description, version, category, config_hash,
             org_id, created_by, approved_by, approved_at, created_at, deleted_at
      FROM gold_images
      WHERE org_id = ${user.org_id}
      ORDER BY created_at DESC
    `;
  }

  return c.json({ images: rows });
});

// ── POST / ───────────────────────────────────────────────────────

const createGoldImageRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Gold Images"],
  summary: "Create a gold image",
  middleware: [requireScope("gold_images:write")],
  request: { body: { content: { "application/json": { schema: createGoldImageSchema } } } },
  responses: {
    200: { description: "Gold image created", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401),
  },
});

goldImageRoutes.openapi(createGoldImageRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const req = c.req.valid("json");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const imageId = randomId();
  const configJson = JSON.stringify(req.config, Object.keys(req.config).sort());
  const hash = await configHashAsync(req.config);
  const now = new Date().toISOString();

  await sql`
    INSERT INTO gold_images (
      image_id, name, config_json, config_hash, org_id,
      description, version, category, created_by, created_at
    ) VALUES (
      ${imageId}, ${req.name}, ${configJson}, ${hash}, ${user.org_id},
      ${req.description}, ${req.version}, ${req.category}, ${user.user_id}, ${now}
    )
  `;

  // Audit trail
  try {
    await sql`
      INSERT INTO config_audit (
        org_id, action, field_changed, new_value, changed_by, image_id, created_at
      ) VALUES (
        ${user.org_id}, ${"gold_image.created"}, ${"*"}, ${req.name},
        ${user.user_id}, ${imageId}, ${now}
      )
    `;
  } catch { /* best-effort */ }

  return c.json({
    image_id: imageId,
    name: req.name,
    version: req.version,
    config_hash: hash,
    category: req.category,
  });
});

// ── GET /audit ───────────────────────────────────────────────────

const auditRoute = createRoute({
  method: "get",
  path: "/audit",
  tags: ["Gold Images"],
  summary: "List config audit entries",
  middleware: [requireScope("gold_images:read")],
  request: { query: auditQuerySchema },
  responses: {
    200: { description: "Audit entries", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

goldImageRoutes.openapi(auditRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, limit } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName) {
    rows = await sql`
      SELECT * FROM config_audit
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM config_audit
      WHERE org_id = ${user.org_id}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }

  return c.json({ entries: rows });
});

// ── POST /from-agent/:agent_name ─────────────────────────────────

const fromAgentRoute = createRoute({
  method: "post",
  path: "/from-agent/{agent_name}",
  tags: ["Gold Images"],
  summary: "Create a gold image from an agent config",
  middleware: [requireScope("gold_images:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: { description: "Gold image created from agent", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

goldImageRoutes.openapi(fromAgentRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Load agent config
  const agentRows = await sql`
    SELECT config FROM agents
    WHERE name = ${agentName} AND org_id = ${user.org_id}
    LIMIT 1
  `;
  if (!agentRows.length) {
    return c.json({ error: `Agent '${agentName}' not found` }, 404);
  }

  const rawConfig = agentRows[0].config;
  const config: Record<string, unknown> =
    typeof rawConfig === "string" ? JSON.parse(rawConfig) : (rawConfig ?? {});

  const goldName = `${agentName}-gold`;
  const imageId = randomId();
  const configJson = JSON.stringify(config, Object.keys(config).sort());
  const hash = await configHashAsync(config);
  const now = new Date().toISOString();
  const version = String(config.version ?? "1.0.0");

  await sql`
    INSERT INTO gold_images (
      image_id, name, config_json, config_hash, org_id,
      description, version, category, created_by, created_at
    ) VALUES (
      ${imageId}, ${goldName}, ${configJson}, ${hash}, ${user.org_id},
      ${`Gold image created from agent '${agentName}'`}, ${version},
      ${"general"}, ${user.user_id}, ${now}
    )
  `;

  // Audit
  try {
    await sql`
      INSERT INTO config_audit (
        org_id, action, field_changed, new_value, changed_by, image_id, created_at
      ) VALUES (
        ${user.org_id}, ${"gold_image.created"}, ${"*"}, ${goldName},
        ${user.user_id}, ${imageId}, ${now}
      )
    `;
  } catch { /* best-effort */ }

  return c.json({
    image_id: imageId,
    name: goldName,
    version,
    config_hash: hash,
    category: "general",
  });
});

// ── GET /compliance/summary ──────────────────────────────────────

const complianceSummaryRoute = createRoute({
  method: "get",
  path: "/compliance/summary",
  tags: ["Gold Images"],
  summary: "Get compliance summary across all agents",
  middleware: [requireScope("gold_images:read")],
  responses: {
    200: { description: "Compliance summary", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

goldImageRoutes.openapi(complianceSummaryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM compliance_checks
    WHERE org_id = ${user.org_id}
    ORDER BY created_at DESC LIMIT 200
  `;

  const summary = complianceSummaryFromChecks(
    rows as unknown as Record<string, unknown>[],
  );
  return c.json(summary);
});

// ── GET /compliance/checks ───────────────────────────────────────

const complianceChecksRoute = createRoute({
  method: "get",
  path: "/compliance/checks",
  tags: ["Gold Images"],
  summary: "List compliance checks",
  middleware: [requireScope("gold_images:read")],
  request: { query: complianceChecksQuerySchema },
  responses: {
    200: { description: "Compliance checks", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

goldImageRoutes.openapi(complianceChecksRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, limit } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName) {
    rows = await sql`
      SELECT * FROM compliance_checks
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM compliance_checks
      WHERE org_id = ${user.org_id}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }

  return c.json({ checks: rows });
});

// ── POST /compliance/check/:agent_name ───────────────────────────

const complianceCheckRoute = createRoute({
  method: "post",
  path: "/compliance/check/{agent_name}",
  tags: ["Gold Images"],
  summary: "Run compliance check for an agent against gold images",
  middleware: [requireScope("gold_images:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
    query: complianceCheckQuerySchema,
  },
  responses: {
    200: { description: "Compliance check result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

goldImageRoutes.openapi(complianceCheckRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  const { image_id: imageId } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Load agent config
  const agentRows = await sql`
    SELECT config FROM agents
    WHERE name = ${agentName} AND org_id = ${user.org_id}
    LIMIT 1
  `;
  if (!agentRows.length) {
    return c.json({ error: `Agent '${agentName}' not found` }, 404);
  }

  const rawConfig = agentRows[0].config;
  const agentConfig: Record<string, unknown> =
    typeof rawConfig === "string" ? JSON.parse(rawConfig) : (rawConfig ?? {});

  if (imageId) {
    // Check against specific gold image
    const goldRows = await sql`
      SELECT * FROM gold_images WHERE image_id = ${imageId} AND deleted_at IS NULL LIMIT 1
    `;
    if (!goldRows.length) {
      return c.json({ error: "Gold image not found" }, 404);
    }

    const gold = goldRows[0] as Record<string, unknown>;
    let goldConfig: Record<string, unknown>;
    try {
      goldConfig = typeof gold.config_json === "string"
        ? JSON.parse(gold.config_json)
        : (gold.config_json ?? {}) as Record<string, unknown>;
    } catch {
      goldConfig = {};
    }

    const report = detectDrift(
      agentConfig, goldConfig,
      agentName, imageId, String(gold.name ?? ""),
    );

    // Persist
    await persistComplianceCheck(sql, user, agentName, gold, report);
    return c.json(report);
  }

  // Check against all relevant gold images
  const allGoldRows = await sql`
    SELECT * FROM gold_images
    WHERE org_id = ${user.org_id} AND deleted_at IS NULL
    ORDER BY created_at DESC
  `;

  if (!allGoldRows.length) {
    return c.json({
      agent_name: agentName,
      image_id: "",
      image_name: "none",
      total_drifts: 0,
      status: "no_gold_images",
      drifted_fields: [],
    });
  }

  // Filter to relevant images
  const agentTags = new Set((agentConfig.tags ?? []) as string[]);
  const agentCategory = String(agentConfig.category ?? "");

  const relevant = allGoldRows.filter((gold) => {
    const goldName = String(gold.name ?? "");
    const goldCategory = String(gold.category ?? "general");
    // Match by name
    if (agentName && (goldName.includes(agentName) || goldName.replace("-gold", "") === agentName)) {
      return true;
    }
    // Match by category
    if (agentCategory && goldCategory === agentCategory) return true;
    // Match by tags
    let goldTags: string[] = [];
    try { goldTags = JSON.parse(String(gold.tags ?? "[]")); } catch { /* empty */ }
    if (agentTags.size && goldTags.some((t) => agentTags.has(t))) return true;
    return false;
  });

  if (!relevant.length) {
    return c.json({
      agent_name: agentName,
      image_id: "",
      image_name: "none",
      total_drifts: 0,
      status: "no_matching_gold_image",
      drifted_fields: [],
    });
  }

  // Find best match (fewest drifts)
  let bestReport: ReturnType<typeof detectDrift> | null = null;
  let bestGold: Record<string, unknown> | null = null;

  for (const gold of relevant) {
    let goldConfig: Record<string, unknown>;
    try {
      goldConfig = typeof gold.config_json === "string"
        ? JSON.parse(gold.config_json)
        : (gold.config_json ?? {}) as Record<string, unknown>;
    } catch {
      goldConfig = {};
    }

    const report = detectDrift(
      agentConfig, goldConfig,
      agentName, String(gold.image_id ?? ""), String(gold.name ?? ""),
    );

    if (!bestReport || report.total_drifts < bestReport.total_drifts) {
      bestReport = report;
      bestGold = gold as Record<string, unknown>;
    }
  }

  if (bestReport && bestGold) {
    await persistComplianceCheck(sql, user, agentName, bestGold, bestReport);
    return c.json(bestReport);
  }

  return c.json({
    agent_name: agentName,
    image_id: "",
    image_name: "none",
    total_drifts: 0,
    status: "no_gold_images",
    drifted_fields: [],
  });
});

async function persistComplianceCheck(
  sql: Awaited<ReturnType<typeof getDbForOrg>>,
  user: CurrentUser,
  agentName: string,
  gold: Record<string, unknown>,
  report: ReturnType<typeof detectDrift>,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    await sql`
      INSERT INTO compliance_checks (
        org_id, agent_name, image_id, image_name,
        status, drift_count, drift_fields, drift_details,
        checked_by, created_at
      ) VALUES (
        ${user.org_id}, ${agentName}, ${String(gold.image_id ?? "")},
        ${String(gold.name ?? "")}, ${report.status}, ${report.total_drifts},
        ${JSON.stringify(report.drifted_fields.map((d) => d.field))},
        ${JSON.stringify(report)}, ${user.user_id}, ${now}
      )
    `;
  } catch {
    // Best-effort persistence
  }
}

// ── POST /drift/:agent_name/:image_id ────────────────────────────

const driftRoute = createRoute({
  method: "post",
  path: "/drift/{agent_name}/{image_id}",
  tags: ["Gold Images"],
  summary: "Detect drift between agent config and gold image",
  middleware: [requireScope("gold_images:write")],
  request: {
    params: z.object({ agent_name: z.string(), image_id: z.string() }),
  },
  responses: {
    200: { description: "Drift report", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

goldImageRoutes.openapi(driftRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, image_id: imageId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Load agent config
  const agentRows = await sql`
    SELECT config FROM agents
    WHERE name = ${agentName} AND org_id = ${user.org_id}
    LIMIT 1
  `;
  if (!agentRows.length) {
    return c.json({ error: `Agent '${agentName}' not found` }, 404);
  }

  const rawConfig = agentRows[0].config;
  const agentConfig: Record<string, unknown> =
    typeof rawConfig === "string" ? JSON.parse(rawConfig) : (rawConfig ?? {});

  // Load gold image
  const goldRows = await sql`
    SELECT * FROM gold_images WHERE image_id = ${imageId} AND deleted_at IS NULL LIMIT 1
  `;
  if (!goldRows.length) {
    return c.json({ error: "Gold image not found" }, 404);
  }

  const gold = goldRows[0] as Record<string, unknown>;
  let goldConfig: Record<string, unknown>;
  try {
    goldConfig = typeof gold.config_json === "string"
      ? JSON.parse(gold.config_json)
      : (gold.config_json ?? {}) as Record<string, unknown>;
  } catch {
    goldConfig = {};
  }

  const report = detectDrift(
    agentConfig, goldConfig,
    agentName, imageId, String(gold.name ?? ""),
  );

  return c.json(report);
});

// ── GET /:image_id ───────────────────────────────────────────────

const getGoldImageRoute = createRoute({
  method: "get",
  path: "/{image_id}",
  tags: ["Gold Images"],
  summary: "Get a gold image by ID",
  middleware: [requireScope("gold_images:read")],
  request: {
    params: z.object({ image_id: z.string() }),
  },
  responses: {
    200: { description: "Gold image detail", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

goldImageRoutes.openapi(getGoldImageRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { image_id: imageId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM gold_images WHERE image_id = ${imageId} AND deleted_at IS NULL LIMIT 1
  `;
  if (!rows.length) {
    return c.json({ error: "Gold image not found" }, 404);
  }

  const image = rows[0] as Record<string, unknown>;
  // Parse config_json into config field
  if (typeof image.config_json === "string") {
    try {
      image.config = JSON.parse(image.config_json);
    } catch {
      image.config = {};
    }
  }

  return c.json(image);
});

// ── PUT /:image_id ───────────────────────────────────────────────

const updateGoldImageRoute = createRoute({
  method: "put",
  path: "/{image_id}",
  tags: ["Gold Images"],
  summary: "Update a gold image",
  middleware: [requireScope("gold_images:write")],
  request: {
    params: z.object({ image_id: z.string() }),
    body: { content: { "application/json": { schema: updateGoldImageSchema } } },
  },
  responses: {
    200: { description: "Gold image updated", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 404),
  },
});

goldImageRoutes.openapi(updateGoldImageRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { image_id: imageId } = c.req.valid("param");
  const req = c.req.valid("json");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const existingRows = await sql`
    SELECT * FROM gold_images WHERE image_id = ${imageId} AND deleted_at IS NULL LIMIT 1
  `;
  if (!existingRows.length) {
    return c.json({ error: "Gold image not found" }, 404);
  }

  const existing = existingRows[0] as Record<string, unknown>;
  const now = new Date().toISOString();
  const changedFields: string[] = [];

  // Apply updates
  if (req.config !== undefined) {
    const configJson = JSON.stringify(req.config, Object.keys(req.config).sort());
    const hash = await configHashAsync(req.config);
    await sql`
      UPDATE gold_images SET config_json = ${configJson}, config_hash = ${hash}
      WHERE image_id = ${imageId}
    `;
    changedFields.push("config_json", "config_hash");
  }
  if (req.name !== undefined) {
    await sql`UPDATE gold_images SET name = ${req.name} WHERE image_id = ${imageId}`;
    changedFields.push("name");
  }
  if (req.description !== undefined) {
    await sql`UPDATE gold_images SET description = ${req.description} WHERE image_id = ${imageId}`;
    changedFields.push("description");
  }
  if (req.version !== undefined) {
    await sql`UPDATE gold_images SET version = ${req.version} WHERE image_id = ${imageId}`;
    changedFields.push("version");
  }

  if (changedFields.length) {
    // Audit trail
    try {
      await sql`
        INSERT INTO config_audit (
          org_id, action, field_changed, old_value, new_value,
          changed_by, image_id, created_at
        ) VALUES (
          ${user.org_id}, ${"gold_image.updated"}, ${changedFields.join(",")},
          ${String(existing.name ?? "")}, ${req.name ?? String(existing.name ?? "")},
          ${user.user_id}, ${imageId}, ${now}
        )
      `;
    } catch { /* best-effort */ }
  }

  // Return updated image
  const updatedRows = await sql`
    SELECT * FROM gold_images WHERE image_id = ${imageId} LIMIT 1
  `;
  const updated = updatedRows[0] as Record<string, unknown>;
  if (typeof updated.config_json === "string") {
    try { updated.config = JSON.parse(updated.config_json); } catch { updated.config = {}; }
  }
  return c.json(updated);
});

// ── POST /:image_id/approve ──────────────────────────────────────

const approveGoldImageRoute = createRoute({
  method: "post",
  path: "/{image_id}/approve",
  tags: ["Gold Images"],
  summary: "Approve a gold image",
  middleware: [requireScope("gold_images:write")],
  request: {
    params: z.object({ image_id: z.string() }),
  },
  responses: {
    200: { description: "Gold image approved", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

goldImageRoutes.openapi(approveGoldImageRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { image_id: imageId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const existingRows = await sql`
    SELECT * FROM gold_images WHERE image_id = ${imageId} AND deleted_at IS NULL LIMIT 1
  `;
  if (!existingRows.length) {
    return c.json({ error: "Gold image not found" }, 404);
  }

  const now = new Date().toISOString();
  await sql`
    UPDATE gold_images SET approved_by = ${user.user_id}, approved_at = ${now}
    WHERE image_id = ${imageId}
  `;

  // Audit
  try {
    await sql`
      INSERT INTO config_audit (
        org_id, action, field_changed, new_value, changed_by, image_id, created_at
      ) VALUES (
        ${user.org_id}, ${"gold_image.approved"}, ${"approved_by"},
        ${user.user_id}, ${user.user_id}, ${imageId}, ${now}
      )
    `;
  } catch { /* best-effort */ }

  return c.json({ approved: true, image_id: imageId });
});

// ── DELETE /:image_id ────────────────────────────────────────────

const deleteGoldImageRoute = createRoute({
  method: "delete",
  path: "/{image_id}",
  tags: ["Gold Images"],
  summary: "Delete (soft) a gold image",
  middleware: [requireScope("gold_images:write")],
  request: {
    params: z.object({ image_id: z.string() }),
  },
  responses: {
    200: { description: "Gold image deleted", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

goldImageRoutes.openapi(deleteGoldImageRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { image_id: imageId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const existingRows = await sql`
    SELECT * FROM gold_images WHERE image_id = ${imageId} AND deleted_at IS NULL LIMIT 1
  `;
  if (!existingRows.length) {
    return c.json({ error: "Gold image not found" }, 404);
  }

  const existing = existingRows[0] as Record<string, unknown>;
  const now = new Date().toISOString();

  // Soft delete
  await sql`
    UPDATE gold_images SET deleted_at = ${now} WHERE image_id = ${imageId}
  `;

  // Audit
  try {
    await sql`
      INSERT INTO config_audit (
        org_id, action, field_changed, old_value, changed_by, image_id, created_at
      ) VALUES (
        ${user.org_id}, ${"gold_image.deleted"}, ${"*"},
        ${String(existing.name ?? "")}, ${user.user_id}, ${imageId}, ${now}
      )
    `;
  } catch { /* best-effort */ }

  return c.json({ deleted: true, image_id: imageId });
});
