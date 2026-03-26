/**
 * Tool Registry — ported from agentos/tools/registry.py
 * 
 * Discovers and manages tool plugins from the tools/ directory.
 * Supports:
 * - JSON tool definitions (declarative)
 * - TypeScript modules with handlers
 * - Built-in handlers integration
 * - MCP-compatible format conversion
 */

import type { Env } from "../env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** JSON Schema for tool input validation */
export interface ToolInputSchema {
  type: string;
  properties?: Record<string, {
    type: string;
    description?: string;
    default?: unknown;
    enum?: string[];
    items?: { type: string };
  }>;
  required?: string[];
}

/** MCP-compatible tool format */
export interface MCPTool {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

/** MCP-compatible server format */
export interface MCPServer {
  name: string;
  tools: MCPTool[];
}

/** Tool handler function signature */
export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext
) => Promise<unknown>;

/** Context passed to tool handlers during execution */
export interface ToolExecutionContext {
  env: Env;
  orgId: string;
  userId: string;
  traceId?: string;
  sessionId?: string;
}

/** Tool plugin with metadata and optional handler */
export interface ToolPlugin {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
  handler?: ToolHandler;
  source_path?: string;
}

/** Raw tool definition from JSON/module */
interface ToolDefinition {
  name: string;
  description?: string;
  input_schema?: ToolInputSchema;
  handler?: ToolHandler;
}

// ---------------------------------------------------------------------------
// Built-in Handlers
// ---------------------------------------------------------------------------

/** Registry of built-in tool handlers */
export const BUILTIN_HANDLERS: Record<string, ToolHandler> = {
  // These are stub implementations that forward to the runtime
  // Full implementations can be added as needed
  
  "web-search": async (args, ctx) => {
    const { query, max_results = 5 } = args;
    // Forward to runtime or implement here
    return {
      results: [],
      query,
      message: `Web search for: ${query} (max_results: ${max_results})`,
    };
  },

  "knowledge-search": async (args, ctx) => {
    const { query, top_k = 5 } = args;
    return {
      results: [],
      query,
      message: `Knowledge search for: ${query} (top_k: ${top_k})`,
    };
  },

  "store-knowledge": async (args, ctx) => {
    const { key, content, tags = [] } = args;
    return {
      stored: true,
      key,
      content_length: String(content).length,
      tags,
    };
  },

  "create-agent": async (args, ctx) => {
    const { description, name } = args;
    return {
      created: true,
      name: name || `agent-${Date.now()}`,
      description,
      message: `Agent created from description`,
    };
  },

  "eval-agent": async (args, ctx) => {
    const { agent_name, eval_file, trials = 3 } = args;
    return {
      agent_name,
      trials,
      pass_rate: 0,
      message: `Evaluated ${agent_name}`,
    };
  },

  "evolve-agent": async (args, ctx) => {
    const { agent_name, action = "analyze" } = args;
    return {
      agent_name,
      action,
      message: `Evolution ${action} for ${agent_name}`,
    };
  },

  "list-agents": async (args, ctx) => {
    return {
      agents: [],
      message: "List of agents",
    };
  },

  "list-tools": async (args, ctx) => {
    return {
      tools: [],
      message: "List of tools",
    };
  },

  "dynamic-exec": async (args, ctx) => {
    const { code, language = "javascript", timeout_ms = 10000 } = args;
    // Forward to CF Workers AI or sandbox
    return {
      executed: true,
      language,
      output: "",
      message: `Executed ${language} code`,
    };
  },

  "web-crawl": async (args, ctx) => {
    const { url, max_pages = 5, max_depth = 1, format = "markdown" } = args;
    return {
      url,
      pages: [],
      format,
    };
  },

  "browser-render": async (args, ctx) => {
    const { url, action = "text", wait_for = "", timeout = 30000 } = args;
    return {
      url,
      action,
      content: "",
    };
  },

  "image-generate": async (args, ctx) => {
    const { prompt, model = "", size = "1024x1024", num_images = 1 } = args;
    return {
      prompt,
      images: [],
    };
  },

  "text-to-speech": async (args, ctx) => {
    const { text, model = "", voice = "default" } = args;
    return {
      text,
      voice,
      audio_url: "",
    };
  },

  "speech-to-text": async (args, ctx) => {
    const { audio_path, model = "", language = "" } = args;
    return {
      text: "",
      language,
    };
  },
};

/** Schemas for built-in tools that don't have JSON files */
const BUILTIN_SCHEMAS: Record<string, { description: string; input_schema: ToolInputSchema }> = {
  "web-search": {
    description: "Search the web for information",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "integer", description: "Maximum results to return", default: 5 },
      },
      required: ["query"],
    },
  },
  "knowledge-search": {
    description: "Search the local knowledge store for relevant information",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        top_k: { type: "integer", description: "Number of results", default: 5 },
      },
      required: ["query"],
    },
  },
  "store-knowledge": {
    description: "Store knowledge in the agent's semantic memory",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to store the knowledge under" },
        content: { type: "string", description: "Content to store" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
      },
      required: ["key", "content"],
    },
  },
};

// ---------------------------------------------------------------------------
// ToolRegistry Class
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private _tools: Map<string, ToolPlugin> = new Map();
  private _discovered = false;
  private _pluginsDir: string;
  private _lastScanTime = 0;
  private _scanIntervalMs = 5000; // Minimum time between scans

  /**
   * Create a new ToolRegistry.
   * @param pluginsDir - Directory containing tool definitions (relative to project root)
   */
  constructor(pluginsDir = "./tools") {
    this._pluginsDir = pluginsDir;
  }

  /**
   * Get the plugins directory path.
   */
  get pluginsDir(): string {
    return this._pluginsDir;
  }

  /**
   * Load built-in handlers and schemas into the registry.
   */
  private _loadBuiltins(): void {
    // Load built-in schemas
    for (const [name, schema] of Object.entries(BUILTIN_SCHEMAS)) {
      if (!this._tools.has(name)) {
        this._tools.set(name, {
          name,
          description: schema.description,
          input_schema: schema.input_schema,
          handler: BUILTIN_HANDLERS[name],
        });
      }
    }

    // Register handlers for any already-loaded tools
    for (const [name, tool] of this._tools.entries()) {
      if (!tool.handler && BUILTIN_HANDLERS[name]) {
        tool.handler = BUILTIN_HANDLERS[name];
      }
    }
  }

  /**
   * Load tool definitions from JSON files.
   * In a Cloudflare Worker, this reads from the bundled assets.
   */
  private async _loadJsonTools(): Promise<void> {
    try {
      // In a real CF Worker deployment, these would be bundled
      // For now, we load from the known set of tool definitions
      const toolFiles = [
        "browser-render.json",
        "create-agent.json",
        "dynamic-exec.json",
        "eval-agent.json",
        "evolve-agent.json",
        "image-generate.json",
        "knowledge-search.json",
        "list-agents.json",
        "list-tools.json",
        "speech-to-text.json",
        "store-knowledge.json",
        "text-to-speech.json",
        "web-crawl.json",
        "web-search.json",
      ];

      for (const filename of toolFiles) {
        try {
          // Try to load from KV or bundled assets
          const toolData = await this._loadToolJson(filename);
          if (toolData) {
            const tools = Array.isArray(toolData) ? toolData : [toolData];
            for (const t of tools) {
              const plugin: ToolPlugin = {
                name: t.name,
                description: t.description || "",
                input_schema: t.input_schema || { type: "object" },
                handler: BUILTIN_HANDLERS[t.name],
                source_path: `${this._pluginsDir}/${filename}`,
              };
              this._tools.set(plugin.name, plugin);
            }
          }
        } catch (err) {
          console.warn(`[ToolRegistry] Failed to load tool from ${filename}:`, err);
        }
      }
    } catch (err) {
      console.warn("[ToolRegistry] Error loading JSON tools:", err);
    }
  }

  /**
   * Load a single tool JSON file.
   * In CF Worker, this would read from KV or bundled assets.
   */
  private async _loadToolJson(filename: string): Promise<ToolDefinition | ToolDefinition[] | null> {
    // In a real implementation, this would:
    // 1. Try to read from KV storage (for dynamic tools)
    // 2. Fall back to bundled static assets
    // 3. Or make a request to a storage service
    
    // For now, return null to indicate we rely on builtins
    // This can be extended to fetch from R2, KV, etc.
    return null;
  }

  /**
   * Load tools from TypeScript/JavaScript modules.
   * Modules should export either:
   * - TOOLS: ToolDefinition[]
   * - register(): ToolDefinition
   */
  private async _loadModuleTools(): Promise<void> {
    // In a CF Worker environment, dynamic module loading is limited
    // Tools would typically be:
    // 1. Pre-registered at build time
    // 2. Loaded from KV as code strings and evaluated (with security considerations)
    // 3. Implemented as external service calls
    
    // This is a placeholder for future dynamic module loading
    console.log("[ToolRegistry] Module loading not implemented in CF Worker environment");
  }

  /**
   * Discover all tools from all sources.
   * This is called lazily on first access.
   */
  private async _discover(): Promise<void> {
    if (this._discovered) {
      return;
    }

    this._loadBuiltins();
    await this._loadJsonTools();
    await this._loadModuleTools();

    this._discovered = true;
    this._lastScanTime = Date.now();
  }

  /**
   * Force a rediscovery of tools.
   * Clears the cache and rescans all sources.
   */
  async reload(): Promise<void> {
    this._tools.clear();
    this._discovered = false;
    await this._discover();
  }

  /**
   * Check if a reload is needed based on scan interval.
   */
  private _shouldReload(): boolean {
    return Date.now() - this._lastScanTime > this._scanIntervalMs;
  }

  /**
   * Register a tool programmatically.
   * @param plugin - The tool plugin to register
   */
  register(plugin: ToolPlugin): void {
    this._tools.set(plugin.name, plugin);
  }

  /**
   * Get a tool by name.
   * @param name - Tool name
   * @returns The tool plugin or undefined if not found
   */
  async get(name: string): Promise<ToolPlugin | undefined> {
    await this._discover();
    return this._tools.get(name);
  }

  /**
   * Get all discovered tools.
   * @returns Array of all tool plugins
   */
  async listAll(): Promise<ToolPlugin[]> {
    await this._discover();
    return Array.from(this._tools.values());
  }

  /**
   * Get all tool names.
   * @returns Array of tool names
   */
  async names(): Promise<string[]> {
    await this._discover();
    return Array.from(this._tools.keys());
  }

  /**
   * Check if a tool exists.
   * @param name - Tool name
   * @returns True if the tool exists
   */
  async has(name: string): Promise<boolean> {
    await this._discover();
    return this._tools.has(name);
  }

  /**
   * Execute a tool by name.
   * @param name - Tool name
   * @param args - Tool arguments
   * @param context - Execution context
   * @returns Tool execution result
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<unknown> {
    const tool = await this.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' not found`);
    }

    if (!tool.handler) {
      throw new Error(`Tool '${name}' has no handler`);
    }

    return await tool.handler(args, context);
  }

  /**
   * Convert a tool to MCP format.
   * @param name - Tool name
   * @returns MCP tool format or undefined if not found
   */
  async toMcpTool(name: string): Promise<MCPTool | undefined> {
    const tool = await this.get(name);
    if (!tool) return undefined;
    return this._pluginToMcpTool(tool);
  }

  /**
   * Convert a plugin to MCP tool format.
   */
  private _pluginToMcpTool(plugin: ToolPlugin): MCPTool {
    return {
      name: plugin.name,
      description: plugin.description,
      input_schema: plugin.input_schema,
    };
  }

  /**
   * Get all tools in MCP format.
   * @returns Array of MCP tools
   */
  async toMcpTools(): Promise<MCPTool[]> {
    const tools = await this.listAll();
    return tools.map(t => this._pluginToMcpTool(t));
  }

  /**
   * Create an MCP server for a specific tool.
   * @param name - Tool name
   * @returns MCP server format or undefined if not found
   */
  async toMcpServer(name: string): Promise<MCPServer | undefined> {
    const tool = await this.toMcpTool(name);
    if (!tool) return undefined;
    return {
      name,
      tools: [tool],
    };
  }

  /**
   * Get tool count.
   * @returns Number of discovered tools
   */
  async count(): Promise<number> {
    await this._discover();
    return this._tools.size;
  }

  /**
   * Get tools with handlers only.
   * @returns Array of tools that have handlers
   */
  async listExecutable(): Promise<ToolPlugin[]> {
    const tools = await this.listAll();
    return tools.filter(t => t.handler !== undefined);
  }

  /**
   * Get tools without handlers (schema-only).
   * @returns Array of tools without handlers
   */
  async listSchemaOnly(): Promise<ToolPlugin[]> {
    const tools = await this.listAll();
    return tools.filter(t => t.handler === undefined);
  }
}

// ---------------------------------------------------------------------------
// Singleton Instance
// ---------------------------------------------------------------------------

let _defaultRegistry: ToolRegistry | null = null;

/**
 * Get the default tool registry instance.
 * This is a singleton for use across the application.
 */
export function getToolRegistry(pluginsDir?: string): ToolRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new ToolRegistry(pluginsDir);
  }
  return _defaultRegistry;
}

/**
 * Reset the default registry (useful for testing).
 */
export function resetToolRegistry(): void {
  _defaultRegistry = null;
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Convert tool input schema to JSON Schema format.
 */
export function schemaToJsonSchema(schema: ToolInputSchema): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    ...schema,
  };
}

/**
 * Validate tool arguments against the input schema.
 * Basic validation - can be extended with a full JSON Schema validator.
 */
export function validateToolArgs(
  args: Record<string, unknown>,
  schema: ToolInputSchema
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required fields
  if (schema.required) {
    for (const field of schema.required) {
      if (!(field in args)) {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }

  // Check property types (basic)
  if (schema.properties) {
    for (const [key, value] of Object.entries(args)) {
      const propSchema = schema.properties[key];
      if (propSchema) {
        const expectedType = propSchema.type;
        const actualType = Array.isArray(value) ? "array" : typeof value;
        if (expectedType && expectedType !== actualType) {
          errors.push(`Field '${key}' should be ${expectedType}, got ${actualType}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
