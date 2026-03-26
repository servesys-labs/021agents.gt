/**
 * Tools router — enhanced port from agentos/tools/registry.py
 * 
 * Features:
 * - GET /tools - List all discovered tools
 * - GET /tools/:name - Get single tool details
 * - POST /tools/:name/execute - Execute a tool (if handler exists)
 * - POST /tools/reload - Rescan tools directory
 * 
 * Tool Registry:
 * - Scans tools/ directory at startup
 * - Supports hot-reload via POST /reload
 * - Caches discovered tools
 * - Returns MCP-compatible format
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import {
  getToolRegistry,
  ToolRegistry,
  validateToolArgs,
  type ToolPlugin,
  type MCPTool,
} from "../lib/toolRegistry";

type R = { Bindings: Env; Variables: { user: CurrentUser } };

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const ToolExecuteSchema = z.object({
  arguments: z.record(z.unknown()).default({}),
  trace_id: z.string().optional(),
  session_id: z.string().optional(),
});

const ToolRegisterSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2000).default(""),
  input_schema: z.record(z.unknown()).default(() => ({ type: "object" })),
  handler_code: z.string().optional(), // For dynamic tool registration
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a tool plugin for API response.
 */
function formatToolResponse(plugin: ToolPlugin): Record<string, unknown> {
  return {
    name: plugin.name,
    description: plugin.description,
    has_handler: plugin.handler !== undefined,
    source: plugin.source_path || "builtin",
    input_schema: plugin.input_schema,
  };
}

/**
 * Format a tool in MCP-compatible format.
 */
function formatMcpTool(plugin: ToolPlugin): MCPTool {
  return {
    name: plugin.name,
    description: plugin.description,
    input_schema: plugin.input_schema,
  };
}

/**
 * Get or create the tool registry.
 */
function getRegistry(): ToolRegistry {
  return getToolRegistry("./tools");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const toolRoutes = new Hono<R>();

// GET /tools — list all discovered tools
// Query params:
//   - format: "default" | "mcp" — response format
//   - has_handler: "true" | "false" | "all" — filter by handler presence
//   - source: filter by source path
//   - search: search in name/description
toolRoutes.get("/", async (c) => {
  const user = c.get("user");
  const format = c.req.query("format") || "default";
  const hasHandlerFilter = c.req.query("has_handler") || "all";
  const sourceFilter = c.req.query("source");
  const searchQuery = c.req.query("search");

  const registry = getRegistry();

  try {
    // Try to get tools from DB registry first (for org-scoped custom tools)
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
    let dbTools: ToolPlugin[] = [];

    try {
      const rows = await sql`
        SELECT name, description, source, has_handler, schema_json, is_builtin
        FROM tool_registry 
        WHERE org_id = ${user.org_id} OR is_builtin = true
        ORDER BY name
      `;

      dbTools = rows.map((r: any) => ({
        name: r.name,
        description: r.description || "",
        input_schema: r.schema_json ? JSON.parse(r.schema_json) : { type: "object" },
        handler: r.has_handler ? undefined : undefined, // Handlers are loaded separately
        source_path: r.source,
      }));
    } catch {
      // Table may not exist, fall back to file-based registry
    }

    // Get file-based tools
    const fileTools = await registry.listAll();

    // Merge tools (DB tools take precedence for overrides)
    const toolMap = new Map<string, ToolPlugin>();

    // Add file-based tools first
    for (const tool of fileTools) {
      toolMap.set(tool.name, tool);
    }

    // Override/add DB tools
    for (const tool of dbTools) {
      toolMap.set(tool.name, tool);
    }

    let tools = Array.from(toolMap.values());

    // Apply filters
    if (hasHandlerFilter === "true") {
      tools = tools.filter(t => t.handler !== undefined);
    } else if (hasHandlerFilter === "false") {
      tools = tools.filter(t => t.handler === undefined);
    }

    if (sourceFilter) {
      tools = tools.filter(t => t.source_path?.includes(sourceFilter));
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      tools = tools.filter(
        t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
      );
    }

    // Format response
    if (format === "mcp") {
      return c.json({
        tools: tools.map(formatMcpTool),
        count: tools.length,
      });
    }

    return c.json({
      tools: tools.map(formatToolResponse),
      count: tools.length,
      _meta: {
        timestamp: Date.now(),
        registry: "file+db",
      },
    });
  } catch (err) {
    console.error("[tools] Error listing tools:", err);

    // Fallback to runtime
    try {
      const resp = await c.env.RUNTIME.fetch("https://runtime/api/v1/tools");
      if (resp.status < 400) {
        return c.json(await resp.json());
      }
    } catch {
      // Final fallback
    }

    // Return built-in tools as last resort
    const tools = await registry.listAll();
    return c.json({
      tools: tools.map(formatToolResponse),
      count: tools.length,
      _meta: { fallback: true },
    });
  }
});

// GET /tools/:name — get single tool details
toolRoutes.get("/:name", async (c) => {
  const { name } = c.req.param();
  const user = c.get("user");
  const format = c.req.query("format") || "default";

  const registry = getRegistry();

  // Try registry first
  let tool = await registry.get(name);

  // Try DB if not in registry
  if (!tool) {
    try {
      const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
      const rows = await sql`
        SELECT name, description, source, has_handler, schema_json, handler_code, is_builtin
        FROM tool_registry 
        WHERE name = ${name} AND (org_id = ${user.org_id} OR is_builtin = true)
        LIMIT 1
      `;

      if (rows.length > 0) {
        const r = rows[0] as any;
        tool = {
          name: r.name,
          description: r.description || "",
          input_schema: r.schema_json ? JSON.parse(r.schema_json) : { type: "object" },
          source_path: r.source,
        };
      }
    } catch {
      // Table may not exist
    }
  }

  if (!tool) {
    return c.json({ error: `Tool '${name}' not found` }, 404);
  }

  if (format === "mcp") {
    return c.json(formatMcpTool(tool));
  }

  return c.json(formatToolResponse(tool));
});

// GET /tools/:name/schema — get tool input schema
toolRoutes.get("/:name/schema", async (c) => {
  const { name } = c.req.param();
  const registry = getRegistry();

  const tool = await registry.get(name);
  if (!tool) {
    return c.json({ error: `Tool '${name}' not found` }, 404);
  }

  return c.json({
    name: tool.name,
    description: tool.description,
    schema: tool.input_schema,
    schema_json: JSON.stringify(tool.input_schema, null, 2),
  });
});

// POST /tools/:name/execute — execute a tool
toolRoutes.post("/:name/execute", requireScope("tools:execute"), async (c) => {
  const { name } = c.req.param();
  const user = c.get("user");

  let body: z.infer<typeof ToolExecuteSchema>;
  try {
    const jsonBody = await c.req.json();
    const parsed = ToolExecuteSchema.safeParse(jsonBody);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        400
      );
    }
    body = parsed.data;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const registry = getRegistry();
  const tool = await registry.get(name);

  if (!tool) {
    return c.json({ error: `Tool '${name}' not found` }, 404);
  }

  // Validate arguments against schema
  const validation = validateToolArgs(body.arguments, tool.input_schema);
  if (!validation.valid) {
    return c.json(
      { error: "Argument validation failed", details: validation.errors },
      400
    );
  }

  // Check if tool has handler
  if (!tool.handler) {
    // Try to forward to runtime
    try {
      const resp = await c.env.RUNTIME.fetch(
        `https://runtime/api/v1/tools/${name}/execute`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(c.env.SERVICE_TOKEN
              ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` }
              : {}),
          },
          body: JSON.stringify({
            arguments: body.arguments,
            org_id: user.org_id,
            user_id: user.user_id,
            trace_id: body.trace_id,
            session_id: body.session_id,
          }),
        }
      );

      if (resp.status < 400) {
        const result = await resp.json();
        return c.json({
          tool: name,
          executed: true,
          result,
          forwarded: true,
        });
      }
    } catch {
      // Fall through to error
    }

    return c.json({ error: `Tool '${name}' has no handler` }, 501);
  }

  // Execute the tool
  const startTime = Date.now();
  try {
    const result = await tool.handler(body.arguments, {
      env: c.env,
      orgId: user.org_id,
      userId: user.user_id,
      traceId: body.trace_id,
      sessionId: body.session_id,
    });

    const duration = Date.now() - startTime;

    // Log tool execution (fire-and-forget)
    try {
      const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
      sql`
        INSERT INTO tool_executions (
          tool_name, org_id, user_id, arguments_json, result_json, 
          duration_ms, trace_id, session_id, created_at
        ) VALUES (
          ${name}, ${user.org_id}, ${user.user_id}, 
          ${JSON.stringify(body.arguments)}, ${JSON.stringify(result)},
          ${duration}, ${body.trace_id || null}, ${body.session_id || null}, 
          ${Date.now() / 1000}
        )
      `.catch(() => {});
    } catch {
      // Non-critical
    }

    return c.json({
      tool: name,
      executed: true,
      duration_ms: duration,
      result,
    });
  } catch (err) {
    const duration = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    return c.json(
      {
        tool: name,
        executed: false,
        duration_ms: duration,
        error: errorMessage,
      },
      500
    );
  }
});

// POST /tools/reload — rescan tools directory
toolRoutes.post("/reload", requireScope("tools:admin"), async (c) => {
  const registry = getRegistry();

  const beforeCount = await registry.count();
  const startTime = Date.now();

  await registry.reload();

  const afterCount = await registry.count();
  const duration = Date.now() - startTime;

  const tools = await registry.listAll();

  return c.json({
    reloaded: true,
    duration_ms: duration,
    before_count: beforeCount,
    after_count: afterCount,
    tools: tools.map(t => ({
      name: t.name,
      has_handler: t.handler !== undefined,
      source: t.source_path || "builtin",
    })),
  });
});

// POST /tools/validate — validate tool arguments without executing
toolRoutes.post("/validate", async (c) => {
  let body: { tool_name: string; arguments: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { tool_name, arguments: args } = body;
  if (!tool_name) {
    return c.json({ error: "tool_name is required" }, 400);
  }

  const registry = getRegistry();
  const tool = await registry.get(tool_name);

  if (!tool) {
    return c.json({ error: `Tool '${tool_name}' not found` }, 404);
  }

  const validation = validateToolArgs(args, tool.input_schema);

  return c.json({
    tool: tool_name,
    valid: validation.valid,
    errors: validation.errors,
    schema: tool.input_schema,
  });
});

// POST /tools — register a new tool (admin only)
toolRoutes.post("/", requireScope("tools:admin"), async (c) => {
  const user = c.get("user");

  let body: z.infer<typeof ToolRegisterSchema>;
  try {
    const jsonBody = await c.req.json();
    const parsed = ToolRegisterSchema.safeParse(jsonBody);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        400
      );
    }
    body = parsed.data;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Check if tool already exists
  const registry = getRegistry();
  const existing = await registry.get(body.name);
  if (existing) {
    return c.json({ error: `Tool '${body.name}' already exists` }, 409);
  }

  // Register in DB for persistence
  try {
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
    await sql`
      INSERT INTO tool_registry (
        name, description, org_id, schema_json, has_handler, 
        handler_code, source, is_builtin, created_at
      ) VALUES (
        ${body.name}, ${body.description}, ${user.org_id},
        ${JSON.stringify(body.input_schema)}, 
        ${body.handler_code ? true : false},
        ${body.handler_code || null},
        'user-defined', false, ${Date.now() / 1000}
      )
    `;
  } catch (err) {
    console.warn("[tools] Failed to persist tool to DB:", err);
    // Continue - tool will be registered in memory only
  }

  // Register in memory
  const plugin: ToolPlugin = {
    name: body.name,
    description: body.description,
    input_schema: body.input_schema as { type: string },
    source_path: "user-defined",
  };

  registry.register(plugin);

  return c.json(
    {
      registered: true,
      tool: formatToolResponse(plugin),
    },
    201
  );
});

// DELETE /tools/:name — unregister a tool (admin only)
toolRoutes.delete("/:name", requireScope("tools:admin"), async (c) => {
  const { name } = c.req.param();
  const user = c.get("user");

  // Cannot delete built-in tools
  const registry = getRegistry();
  const tool = await registry.get(name);

  if (!tool) {
    return c.json({ error: `Tool '${name}' not found` }, 404);
  }

  if (tool.source_path === "builtin" || !tool.source_path) {
    return c.json({ error: "Cannot delete built-in tools" }, 403);
  }

  // Remove from DB
  try {
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
    await sql`
      DELETE FROM tool_registry 
      WHERE name = ${name} AND org_id = ${user.org_id}
    `;
  } catch (err) {
    console.warn("[tools] Failed to remove tool from DB:", err);
  }

  // Note: In-memory tools persist until next reload
  // This is intentional - deletion affects DB for next startup

  return c.json({
    deleted: name,
    message: "Tool unregistered (will be removed on next reload)",
  });
});

// GET /tools/:name/executions — get execution history for a tool
toolRoutes.get("/:name/executions", async (c) => {
  const { name } = c.req.param();
  const user = c.get("user");
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);
  const offset = parseInt(c.req.query("offset") || "0");

  try {
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
    const rows = await sql`
      SELECT 
        execution_id, arguments_json, result_json, duration_ms, 
        trace_id, session_id, created_at, error
      FROM tool_executions 
      WHERE tool_name = ${name} AND org_id = ${user.org_id}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countResult = await sql`
      SELECT COUNT(*) as total 
      FROM tool_executions 
      WHERE tool_name = ${name} AND org_id = ${user.org_id}
    `;
    const total = Number((countResult[0] as any)?.total || 0);

    return c.json({
      tool: name,
      executions: rows.map((r: any) => ({
        id: r.execution_id,
        arguments: r.arguments_json ? JSON.parse(r.arguments_json) : {},
        result: r.result_json ? JSON.parse(r.result_json) : null,
        duration_ms: r.duration_ms,
        trace_id: r.trace_id,
        session_id: r.session_id,
        created_at: r.created_at,
        error: r.error,
      })),
      pagination: {
        total,
        limit,
        offset,
        has_more: offset + rows.length < total,
      },
    });
  } catch {
    return c.json({
      tool: name,
      executions: [],
      pagination: { total: 0, limit, offset, has_more: false },
    });
  }
});

// GET /tools/mcp/server — get all tools as MCP server format
toolRoutes.get("/mcp/server", async (c) => {
  const registry = getRegistry();
  const tools = await registry.toMcpTools();

  return c.json({
    name: "agentos-tools",
    version: "1.0.0",
    tools,
  });
});

// GET /tools/stats — get tool usage statistics
toolRoutes.get("/stats", async (c) => {
  const user = c.get("user");

  try {
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    const [totalResult, toolCounts, recentErrors] = await Promise.all([
      sql`SELECT COUNT(*) as total FROM tool_executions WHERE org_id = ${user.org_id}`,
      sql`
        SELECT 
          tool_name, 
          COUNT(*) as execution_count,
          AVG(duration_ms) as avg_duration_ms,
          MAX(created_at) as last_executed
        FROM tool_executions 
        WHERE org_id = ${user.org_id}
        GROUP BY tool_name
        ORDER BY execution_count DESC
        LIMIT 20
      `,
      sql`
        SELECT tool_name, error, created_at
        FROM tool_executions 
        WHERE org_id = ${user.org_id} AND error IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 10
      `,
    ]);

    const total = Number((totalResult[0] as any)?.total || 0);

    return c.json({
      total_executions: total,
      tool_breakdown: toolCounts,
      recent_errors: recentErrors,
    });
  } catch {
    return c.json({
      total_executions: 0,
      tool_breakdown: [],
      recent_errors: [],
    });
  }
});
