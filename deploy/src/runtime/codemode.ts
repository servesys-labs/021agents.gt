/**
 * Edge Runtime — Code Mode (Discover + Execute pattern).
 *
 * Uses @cloudflare/codemode core to collapse agent tools into a
 * code-execution meta-tool. The LLM writes JavaScript that orchestrates
 * multiple tool calls in a single turn.
 *
 * Architecture:
 *   1. generateTypesFromJsonSchema() creates TypeScript types from tool schemas
 *   2. LLM writes async JS code using those types
 *   3. DynamicWorkerExecutor runs the code in an isolated V8 isolate
 *   4. ToolDispatcher routes tool calls from sandbox → parent via RPC
 *   5. Parent executes actual tools with full bindings and auth
 *
 * Security:
 *   - globalOutbound: null → sandbox has zero network access
 *   - env: {} → sandbox has zero bindings (no secrets, no DB)
 *   - All tool execution goes through ToolDispatcher RPC → parent worker
 */

import {
  DynamicWorkerExecutor,
  ToolDispatcher,
  generateTypesFromJsonSchema,
  normalizeCode,
  resolveProvider,
  type JsonSchemaToolDescriptors,
  type ExecuteResult,
} from "@cloudflare/codemode";
import type { RuntimeEnv, ToolDefinition } from "./types";
import { executeTools } from "./tools";

/**
 * Execute LLM-generated code in a sandboxed Dynamic Worker.
 * Tool calls from inside the sandbox route back to the parent via RPC.
 */
export async function executeCode(
  env: RuntimeEnv,
  code: string,
  toolDefs: ToolDefinition[],
  sessionId: string,
): Promise<ExecuteResult> {
  // Build tool functions that the sandbox can call via RPC
  const toolFns: Record<string, (args: any) => Promise<unknown>> = {};

  for (const def of toolDefs) {
    const toolName = def.function.name;
    toolFns[toolName] = async (args: any) => {
      const results = await executeTools(
        env,
        [{ id: `cm-${Date.now()}`, name: toolName, arguments: JSON.stringify(args) }],
        sessionId,
        false,
      );
      const result = results[0];
      if (result?.error) throw new Error(result.error);
      try {
        return JSON.parse(result?.result || "null");
      } catch {
        return result?.result || null;
      }
    };
  }

  // Resolve providers from our tool definitions
  const descriptors: JsonSchemaToolDescriptors = {};
  for (const def of toolDefs) {
    descriptors[def.function.name] = {
      description: def.function.description,
      inputSchema: def.function.parameters as any,
    };
  }

  const provider = resolveProvider({
    name: "codemode",
    tools: toolFns as unknown as Parameters<typeof resolveProvider>[0]["tools"],
    types: generateTypesFromJsonSchema(descriptors),
  });

  // Normalize the code (sanitize, validate syntax)
  const normalized = normalizeCode(code);

  // Execute in sandboxed Dynamic Worker
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout: 30_000,
    globalOutbound: null, // Fully isolated — no network from sandbox
  });

  return executor.execute(normalized, [provider]);
}

/**
 * Get TypeScript type definitions for all available tools.
 * The LLM calls discover-api → gets these types → writes code against them.
 */
export function getToolTypeDefinitions(toolDefs: ToolDefinition[]): string {
  const descriptors: JsonSchemaToolDescriptors = {};
  for (const def of toolDefs) {
    descriptors[def.function.name] = {
      description: def.function.description,
      inputSchema: def.function.parameters as any,
    };
  }
  return generateTypesFromJsonSchema(descriptors);
}
