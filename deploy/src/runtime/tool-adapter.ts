/**
 * Tool Adapter
 * 
 * Provides patterns for importing and using external tools within AgentOS runtime.
 * Supports both JavaScript tools (via Dynamic Workers) and Python tools (via Sandbox).
 */

import type { ToolDefinition, ToolResult } from "./types";
import { log } from "./log";

// ── External Tool Interface ─────────────────────────────────────────

interface ExternalJSTool {
  name: string;
  description: string;
  schema: {
    properties: Record<string, unknown>;
    required?: string[];
  };
  invoke(args: Record<string, unknown>): Promise<unknown>;
}

interface ExternalPythonTool {
  name: string;
  description: string;
  code: string;
  entry_point: string;
  requirements?: string[];
  schema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// ── Adapter Functions ───────────────────────────────────────────────

/**
 * Wrap an external JavaScript tool for use in AgentOS.
 */
export function wrapExternalTool(
  tool: ExternalJSTool,
  options: {
    timeoutMs?: number;
    costPerCall?: number;
  } = {}
): ToolDefinition & { 
  handler: (args: Record<string, unknown>) => Promise<string>;
  costModel: { flat_usd: number; per_ms_usd: number };
} {
  const timeoutMs = options.timeoutMs || 30_000;
  
  return {
    type: "function",
    function: {
      name: sanitizeToolName(tool.name),
      description: tool.description,
      parameters: {
        type: "object",
        properties: tool.schema.properties,
        required: tool.schema.required || [],
      },
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      try {
        const result = await Promise.race([
          tool.invoke(args),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error("Tool timeout")), timeoutMs)
          ),
        ]);
        
        if (typeof result === "string") return result;
        if (result === null || result === undefined) return "";
        return JSON.stringify(result, null, 2);
      } catch (err: any) {
        throw new Error(`Tool failed: ${err.message}`);
      }
    },
    costModel: {
      flat_usd: options.costPerCall || 0.001,
      per_ms_usd: 0,
    },
  };
}

/**
 * Import a Python tool to run in Sandbox.
 */
export function importPythonTool(
  spec: ExternalPythonTool,
  options: {
    timeoutMs?: number;
    memoryMB?: number;
    costPerCall?: number;
  } = {}
): ToolDefinition & { 
  sandboxConfig: {
    image: string;
    code: string;
    entryPoint: string;
    requirements: string[];
    timeout: number;
    memory: number;
  };
  costModel: { flat_usd: number; per_ms_usd: number };
} {
  const timeoutMs = options.timeoutMs || 60_000;
  const memoryMB = options.memoryMB || 512;
  
  const wrapperCode = generatePythonWrapper(spec);
  
  return {
    type: "function",
    function: {
      name: sanitizeToolName(spec.name),
      description: spec.description,
      parameters: {
        type: "object",
        properties: spec.schema?.properties || {},
        required: spec.schema?.required || [],
      },
    },
    sandboxConfig: {
      image: "python:3.11-slim",
      code: wrapperCode,
      entryPoint: "run",
      requirements: [
        "requests>=2.28.0",
        ...(spec.requirements || []),
      ],
      timeout: timeoutMs,
      memory: memoryMB,
    },
    costModel: {
      flat_usd: options.costPerCall || 0.01,
      per_ms_usd: 0.00001,
    },
  };
}

/**
 * Convert external tool definitions to AgentOS format.
 */
export async function convertExternalTools(
  toolUrls: string[],
  options: { 
    proxyEndpoint?: string;
    apiKey?: string;
  } = {}
): Promise<Array<ToolDefinition & { externalEndpoint?: string }>> {
  const tools: Array<ToolDefinition & { externalEndpoint?: string }> = [];
  
  for (const url of toolUrls) {
    try {
      const response = await fetch(url, {
        headers: options.apiKey ? { "Authorization": `Bearer ${options.apiKey}` } : {},
      });
      
      if (!response.ok) {
        log.warn(`Failed to fetch tool from ${url}: ${response.status}`);
        continue;
      }
      
      const manifest = await response.json() as {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
        endpoint?: string;
      };
      
      tools.push({
        type: "function",
        function: {
          name: sanitizeToolName(manifest.name),
          description: manifest.description,
          parameters: manifest.parameters as any,
        },
        externalEndpoint: manifest.endpoint || url,
      });
    } catch (err) {
      log.warn(`Failed to load tool from ${url}:`, err);
    }
  }
  
  return tools;
}

/**
 * Export AgentOS tool to external format.
 */
export function exportToolToExternalFormat(
  tool: ToolDefinition & { handler?: (args: Record<string, unknown>) => Promise<unknown> }
): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  endpoint?: string;
} {
  return {
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    endpoint: (tool as any).externalEndpoint,
  };
}

/**
 * Convert a runnable sequence to a graph specification.
 */
export function convertSequenceToGraph(
  steps: Array<{
    name: string;
    type: string;
    config?: Record<string, unknown>;
  }>
): {
  nodes: Array<{ id: string; type: string; config?: Record<string, unknown> }>;
  edges: Array<{ source: string; target: string }>;
} {
  const nodes = steps.map((step, i) => ({
    id: step.name || `step_${i}`,
    type: step.type,
    config: step.config,
  }));
  
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({
      source: nodes[i].id,
      target: nodes[i + 1].id,
    });
  }
  
  return { nodes, edges };
}

/**
 * Auto-register tools from environment.
 */
export async function autoRegisterTools(
  registerFn: (tool: ToolDefinition) => void
): Promise<void> {
  // Register built-in tools based on environment
  // This is a placeholder - actual implementation would scan for available tools
  log.info("Auto-registering tools...");
}

// ── Helpers ─────────────────────────────────────────────────────────

function sanitizeToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 64);
}

function generatePythonWrapper(spec: ExternalPythonTool): string {
  return `
import json
import sys

def run(input_data):
    """Auto-generated wrapper for ${spec.name}"""
    # Import user code
    exec("""
${spec.code}
    """)
    
    # Call entry point
    result = ${spec.entry_point}(input_data)
    return json.dumps(result)

if __name__ == "__main__":
    input = sys.stdin.read()
    input_data = json.loads(input)
    output = run(input_data)
    print(output)
`;
}
