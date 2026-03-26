/**
 * Graph state schema validation — JSON Schema for node inputs/outputs.
 * 
 * Ensures type safety across graph transitions:
 * - Validates node outputs match expected schema
 * - Generates TypeScript types for portal
 * - Detects incompatible edge connections
 */

import { z } from "zod";

// ── JSON Schema Types ────────────────────────────────────────────────

export type JsonSchemaType = 
  | "string" 
  | "number" 
  | "integer" 
  | "boolean" 
  | "array" 
  | "object" 
  | "null";

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
  // String validations
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  // Number validations
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  // Array validations
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  // Object validations
  additionalProperties?: boolean | JsonSchema;
  // References
  $ref?: string;
  // Format hint
  format?: string;
  // Composition
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
}

// ── Node Schema Definition ───────────────────────────────────────────

export interface NodeSchema {
  node_kind: string;
  version: string;
  description?: string;
  
  // Input schema for this node
  input_schema: JsonSchema;
  
  // Output schema this node produces
  output_schema: JsonSchema;
  
  // Config schema (node configuration parameters)
  config_schema?: JsonSchema;
  
  // State mutations: which keys this node reads/writes
  state_reads?: string[];
  state_writes?: string[];
}

// ── Validation Result ───────────────────────────────────────────────

export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaError[];
  warnings: SchemaWarning[];
}

export interface SchemaError {
  code: string;
  message: string;
  path: string;
  node_id?: string;
  edge_id?: string;
}

export interface SchemaWarning {
  code: string;
  message: string;
  path: string;
}

// ── Schema Registry ─────────────────────────────────────────────────

class SchemaRegistry {
  private schemas = new Map<string, NodeSchema>();
  
  register(schema: NodeSchema): void {
    const key = `${schema.node_kind}@${schema.version}`;
    this.schemas.set(key, schema);
    // Also register without version as "latest"
    this.schemas.set(schema.node_kind, schema);
  }
  
  get(kind: string, version?: string): NodeSchema | undefined {
    if (version) {
      return this.schemas.get(`${kind}@${version}`);
    }
    return this.schemas.get(kind);
  }
  
  list(): NodeSchema[] {
    return Array.from(this.schemas.values());
  }
}

export const schemaRegistry = new SchemaRegistry();

// ── Built-in Schemas ────────────────────────────────────────────────

schemaRegistry.register({
  node_kind: "fresh_route_llm",
  version: "1.0.0",
  description: "Routes to appropriate LLM based on plan/complexity",
  input_schema: {
    type: "object",
    properties: {
      messages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
            content: { type: "string" },
          },
          required: ["role", "content"],
        },
      },
      tools: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
          },
          required: ["name", "description"],
        },
      },
    },
    required: ["messages"],
  },
  output_schema: {
    type: "object",
    properties: {
      content: { type: "string", description: "LLM response text" },
      tool_calls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            arguments: { type: "string" },
          },
          required: ["id", "name", "arguments"],
        },
      },
      model: { type: "string", description: "Model used for generation" },
      usage: {
        type: "object",
        properties: {
          input_tokens: { type: "integer" },
          output_tokens: { type: "integer" },
        },
        required: ["input_tokens", "output_tokens"],
      },
    },
    required: ["content", "model", "usage"],
  },
  state_reads: ["messages", "config.model", "config.plan"],
  state_writes: ["last_response", "last_model", "turn_cost"],
});

schemaRegistry.register({
  node_kind: "fresh_tools",
  version: "1.0.0",
  description: "Execute tool calls",
  input_schema: {
    type: "object",
    properties: {
      tool_calls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            arguments: { type: "string" },
          },
          required: ["id", "name", "arguments"],
        },
      },
    },
    required: ["tool_calls"],
  },
  output_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool_call_id: { type: "string" },
            result: { type: "string" },
            error: { type: "string" },
            latency_ms: { type: "integer" },
          },
          required: ["tool_call_id"],
        },
      },
      total_cost_usd: { type: "number" },
    },
    required: ["results"],
  },
  state_reads: ["tool_calls", "config.tools"],
  state_writes: ["tool_results", "cumulative_cost"],
});

schemaRegistry.register({
  node_kind: "web_search",
  version: "1.0.0",
  description: "Search the web using Brave Search",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      count: { type: "integer", minimum: 1, maximum: 20, default: 5 },
    },
    required: ["query"],
  },
  output_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string", format: "uri" },
            snippet: { type: "string" },
          },
          required: ["title", "url"],
        },
      },
      total_results: { type: "integer" },
    },
    required: ["results"],
  },
});

// ── Validation Functions ────────────────────────────────────────────

export function validateDataAgainstSchema(
  data: unknown,
  schema: JsonSchema,
  path = ""
): SchemaValidationResult {
  const errors: SchemaError[] = [];
  const warnings: SchemaWarning[] = [];
  
  // Handle null/undefined
  if (data === null || data === undefined) {
    if (schema.type && !includesType(schema.type, "null")) {
      errors.push({
        code: "NULL_NOT_ALLOWED",
        message: `Expected ${schema.type}, got null`,
        path,
      });
    }
    return { valid: errors.length === 0, errors, warnings };
  }
  
  // Type validation
  const actualType = getJsonType(data);
  if (schema.type && !includesType(schema.type, actualType)) {
    errors.push({
      code: "TYPE_MISMATCH",
      message: `Expected ${Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type}, got ${actualType}`,
      path,
    });
    return { valid: false, errors, warnings };
  }
  
  // Object validation
  if (actualType === "object" && schema.properties) {
    const obj = data as Record<string, unknown>;
    
    // Check required properties
    for (const req of schema.required || []) {
      if (!(req in obj)) {
        errors.push({
          code: "REQUIRED_PROPERTY",
          message: `Missing required property: ${req}`,
          path: `${path}.${req}`,
        });
      }
    }
    
    // Validate each property
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in obj) {
        const result = validateDataAgainstSchema(obj[key], propSchema, `${path}.${key}`);
        errors.push(...result.errors);
        warnings.push(...result.warnings);
      }
    }
  }
  
  // Array validation
  if (actualType === "array" && schema.items) {
    const arr = data as unknown[];
    
    if (schema.minItems !== undefined && arr.length < schema.minItems) {
      errors.push({
        code: "MIN_ITEMS",
        message: `Array must have at least ${schema.minItems} items`,
        path,
      });
    }
    
    if (schema.maxItems !== undefined && arr.length > schema.maxItems) {
      errors.push({
        code: "MAX_ITEMS",
        message: `Array must have at most ${schema.maxItems} items`,
        path,
      });
    }
    
    for (let i = 0; i < arr.length; i++) {
      const result = validateDataAgainstSchema(arr[i], schema.items, `${path}[${i}]`);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }
  }
  
  // String validation
  if (actualType === "string") {
    const str = data as string;
    
    if (schema.minLength !== undefined && str.length < schema.minLength) {
      errors.push({
        code: "MIN_LENGTH",
        message: `String must be at least ${schema.minLength} characters`,
        path,
      });
    }
    
    if (schema.maxLength !== undefined && str.length > schema.maxLength) {
      errors.push({
        code: "MAX_LENGTH",
        message: `String must be at most ${schema.maxLength} characters`,
        path,
      });
    }
    
    if (schema.pattern) {
      const regex = new RegExp(schema.pattern);
      if (!regex.test(str)) {
        errors.push({
          code: "PATTERN",
          message: `String must match pattern: ${schema.pattern}`,
          path,
        });
      }
    }
  }
  
  // Number validation
  if (actualType === "number" || actualType === "integer") {
    const num = data as number;
    
    if (schema.minimum !== undefined && num < schema.minimum) {
      errors.push({
        code: "MINIMUM",
        message: `Number must be >= ${schema.minimum}`,
        path,
      });
    }
    
    if (schema.maximum !== undefined && num > schema.maximum) {
      errors.push({
        code: "MAXIMUM",
        message: `Number must be <= ${schema.maximum}`,
        path,
      });
    }
    
    if (actualType === "integer" && !Number.isInteger(num)) {
      errors.push({
        code: "INTEGER",
        message: "Number must be an integer",
        path,
      });
    }
  }
  
  return { valid: errors.length === 0, errors, warnings };
}

export function validateGraphSchemas(
  nodes: Array<{ id: string; kind?: string; type?: string }>,
  edges: Array<{ source?: string; target?: string; from?: string; to?: string }>,
  registry: SchemaRegistry = schemaRegistry
): SchemaValidationResult {
  const errors: SchemaError[] = [];
  const warnings: SchemaWarning[] = [];
  
  // Build node map
  const nodeMap = new Map<string, { id: string; kind?: string; type?: string }>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
  }
  
  // Validate each node's schema is registered
  for (const node of nodes) {
    const kind = node.kind || node.type;
    if (!kind) continue;
    
    const schema = registry.get(kind);
    if (!schema) {
      warnings.push({
        code: "UNKNOWN_NODE_KIND",
        message: `No schema registered for node kind: ${kind}`,
        path: `nodes.${node.id}`,
      });
    }
  }
  
  // Validate edge compatibility
  for (const edge of edges) {
    const sourceId = String(edge.source || edge.from);
    const targetId = String(edge.target || edge.to);
    
    const sourceNode = nodeMap.get(sourceId);
    const targetNode = nodeMap.get(targetId);
    
    if (!sourceNode || !targetNode) continue;
    
    const sourceSchema = registry.get(sourceNode.kind || sourceNode.type || "");
    const targetSchema = registry.get(targetNode.kind || targetNode.type || "");
    
    if (sourceSchema && targetSchema) {
      // Check if target's required inputs can be satisfied by source's outputs
      const sourceOutputs = new Set(Object.keys(sourceSchema.output_schema.properties || {}));
      const targetInputs = new Set(targetSchema.state_reads || []);
      
      // This is a simplified check - in reality you'd do more sophisticated type matching
      for (const input of targetSchema.state_reads || []) {
        if (!sourceOutputs.has(input) && !isGlobalState(input)) {
          warnings.push({
            code: "POTENTIAL_MISSING_INPUT",
            message: `${targetNode.id} reads '${input}' but ${sourceNode.id} doesn't output it`,
            path: `edges.${sourceId}->${targetId}`,
          });
        }
      }
    }
  }
  
  return { valid: errors.length === 0, errors, warnings };
}

// ── TypeScript Generation ───────────────────────────────────────────

export function generateTypeScriptTypes(
  schemas: NodeSchema[],
  options: { includeComments?: boolean } = {}
): string {
  const lines: string[] = [];
  lines.push("// Auto-generated from graph schemas");
  lines.push("// Do not edit manually");
  lines.push("");
  
  for (const schema of schemas) {
    if (options.includeComments !== false) {
      lines.push(`/** ${schema.description} */`);
    }
    
    const interfaceName = toPascalCase(schema.node_kind);
    
    // Input type
    lines.push(`export interface ${interfaceName}Input {`);
    lines.push(...generateInterfaceBody(schema.input_schema, options));
    lines.push("}");
    lines.push("");
    
    // Output type
    lines.push(`export interface ${interfaceName}Output {`);
    lines.push(...generateInterfaceBody(schema.output_schema, options));
    lines.push("}");
    lines.push("");
  }
  
  return lines.join("\n");
}

function generateInterfaceBody(schema: JsonSchema, options: { indent?: number; includeComments?: boolean } = {}): string[] {
  const indent = " ".repeat(options.indent || 2);
  const lines: string[] = [];
  
  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const isRequired = schema.required?.includes(key);
      const type = jsonSchemaToTypeScript(prop);
      const optional = isRequired ? "" : "?";
      lines.push(`${indent}${key}${optional}: ${type};`);
    }
  }
  
  return lines;
}

function jsonSchemaToTypeScript(schema: JsonSchema): string {
  if (schema.enum) {
    return schema.enum.map(e => JSON.stringify(e)).join(" | ");
  }
  
  if (schema.oneOf) {
    return schema.oneOf.map(s => jsonSchemaToTypeScript(s)).join(" | ");
  }
  
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      if (schema.items) {
        return `${jsonSchemaToTypeScript(schema.items)}[]`;
      }
      return "unknown[]";
    case "object":
      if (schema.properties) {
        const props = Object.entries(schema.properties)
          .map(([k, v]) => `${k}: ${jsonSchemaToTypeScript(v)}`)
          .join("; ");
        return `{ ${props} }`;
      }
      return "Record<string, unknown>";
    default:
      return "unknown";
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function getJsonType(value: unknown): JsonSchemaType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  if (typeof value === "boolean") return "boolean";
  return "null";
}

function includesType(types: JsonSchemaType | JsonSchemaType[], actual: JsonSchemaType): boolean {
  if (Array.isArray(types)) {
    return types.includes(actual);
  }
  return types === actual;
}

function isGlobalState(path: string): boolean {
  // These are available globally in the agent context
  const globals = ["config", "org_id", "project_id", "agent_name"];
  return globals.some(g => path.startsWith(g));
}

function toPascalCase(str: string): string {
  return str
    .split(/[_-]/)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}
