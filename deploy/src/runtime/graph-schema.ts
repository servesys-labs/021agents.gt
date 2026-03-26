/**
 * Graph Schema Validation
 * 
 * JSON Schema-based validation for graph inputs/outputs and node data.
 */

import type { GraphSpec } from "./linear_declarative";

// ── Types ────────────────────────────────────────────────────────────

export interface JsonSchema {
  type: "object" | "array" | "string" | "number" | "boolean" | "null" | "integer";
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
}

export interface NodeSchema {
  node_id: string;
  input_schema?: JsonSchema;
  output_schema?: JsonSchema;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;
    message: string;
    value?: unknown;
  }>;
}

export interface SchemaRegistry {
  register(name: string, schema: JsonSchema): void;
  get(name: string): JsonSchema | undefined;
  validate(data: unknown, schema: JsonSchema): SchemaValidationResult;
}

// ── Schema Registry ──────────────────────────────────────────────────

class JsonSchemaRegistry implements SchemaRegistry {
  private schemas = new Map<string, JsonSchema>();

  register(name: string, schema: JsonSchema): void {
    this.schemas.set(name, schema);
  }

  get(name: string): JsonSchema | undefined {
    return this.schemas.get(name);
  }

  validate(data: unknown, schema: JsonSchema): SchemaValidationResult {
    return validateDataAgainstSchema(data, schema, this);
  }
}

export const schemaRegistry: SchemaRegistry = new JsonSchemaRegistry();

// ── Validation Functions ─────────────────────────────────────────────

export function validateDataAgainstSchema(
  data: unknown,
  schema: JsonSchema,
  registry?: SchemaRegistry
): SchemaValidationResult {
  const errors: Array<{ path: string; message: string; value?: unknown }> = [];

  function validate(value: unknown, schema: JsonSchema, path: string): void {
    // Handle $ref
    if (schema.$ref && registry) {
      const refSchema = registry.get(schema.$ref);
      if (refSchema) {
        validate(value, refSchema, path);
        return;
      }
    }

    // Handle oneOf, anyOf, allOf
    if (schema.oneOf) {
      const validCount = schema.oneOf.filter(s => validateDataAgainstSchema(value, s, registry).valid).length;
      if (validCount !== 1) {
        errors.push({ path, message: `Expected exactly one of ${schema.oneOf.length} schemas to match, but ${validCount} matched`, value });
      }
      return;
    }

    if (schema.anyOf) {
      const validCount = schema.anyOf.filter(s => validateDataAgainstSchema(value, s, registry).valid).length;
      if (validCount === 0) {
        errors.push({ path, message: `Expected at least one of ${schema.anyOf.length} schemas to match`, value });
      }
      return;
    }

    if (schema.allOf) {
      for (const subSchema of schema.allOf) {
        validate(value, subSchema, path);
      }
      return;
    }

    // Type validation
    if (schema.type) {
      const actualType = getJsonType(value);
      if (!isTypeMatch(actualType, schema.type)) {
        errors.push({ path, message: `Expected type ${schema.type}, got ${actualType}`, value });
        return;
      }
    }

    // Null check for null type
    if (schema.type === "null" && value !== null) {
      errors.push({ path, message: "Expected null", value });
      return;
    }

    if (value === null || value === undefined) {
      // If nullable (type includes null), it's valid
      if (schema.type !== "null" && (!Array.isArray(schema.type) || !schema.type.includes("null"))) {
        // Check if this is an optional field in an object context
        // For now, null is only valid if type is explicitly "null"
      }
      return;
    }

    // Enum validation
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push({ path, message: `Expected one of ${JSON.stringify(schema.enum)}`, value });
    }

    // String validations
    if (typeof value === "string") {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push({ path, message: `String length ${value.length} is less than minimum ${schema.minLength}`, value });
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push({ path, message: `String length ${value.length} exceeds maximum ${schema.maxLength}`, value });
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        errors.push({ path, message: `String does not match pattern ${schema.pattern}`, value });
      }
      if (schema.format) {
        const formatValid = validateFormat(value, schema.format);
        if (!formatValid) {
          errors.push({ path, message: `String does not match format ${schema.format}`, value });
        }
      }
    }

    // Number validations
    if (typeof value === "number") {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push({ path, message: `Number ${value} is less than minimum ${schema.minimum}`, value });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push({ path, message: `Number ${value} exceeds maximum ${schema.maximum}`, value });
      }
      if (schema.type === "integer" && !Number.isInteger(value)) {
        errors.push({ path, message: `Expected integer, got ${value}`, value });
      }
    }

    // Object validations
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;

      // Required fields
      if (schema.required) {
        for (const key of schema.required) {
          if (!(key in obj) || obj[key] === undefined) {
            errors.push({ path: `${path}.${key}`, message: `Required property '${key}' is missing` });
          }
        }
      }

      // Properties
      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key in obj) {
            validate(obj[key], propSchema, `${path}.${key}`);
          }
        }
      }

      // Additional properties
      if (schema.additionalProperties === false) {
        const allowedKeys = new Set(Object.keys(schema.properties || {}));
        for (const key of Object.keys(obj)) {
          if (!allowedKeys.has(key)) {
            errors.push({ path: `${path}.${key}`, message: `Additional property '${key}' is not allowed` });
          }
        }
      } else if (typeof schema.additionalProperties === "object") {
        const allowedKeys = new Set(Object.keys(schema.properties || {}));
        for (const [key, val] of Object.entries(obj)) {
          if (!allowedKeys.has(key)) {
            validate(val, schema.additionalProperties, `${path}.${key}`);
          }
        }
      }
    }

    // Array validations
    if (Array.isArray(value) && schema.items) {
      for (let i = 0; i < value.length; i++) {
        validate(value[i], schema.items, `${path}[${i}]`);
      }
    }
  }

  validate(data, schema, "$");

  return { valid: errors.length === 0, errors };
}

function getJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function isTypeMatch(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (expected === "number" && actual === "integer") return true;
  return false;
}

function validateFormat(value: string, format: string): boolean {
  switch (format) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case "uri":
    case "url":
      try { new URL(value); return true; } catch { return false; }
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(value);
    case "date-time":
      return !isNaN(Date.parse(value));
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    default:
      return true;
  }
}

// ── Graph Schema Validation ──────────────────────────────────────────

export interface GraphValidationResult {
  valid: boolean;
  errors: Array<{ code: string; message: string; path?: string }>;
  warnings: Array<{ code: string; message: string }>;
}

export function validateGraphSchemas(
  graph: GraphSpec,
  registry?: SchemaRegistry
): GraphValidationResult {
  const errors: Array<{ code: string; message: string; path?: string }> = [];
  const warnings: Array<{ code: string; message: string }> = [];

  // Validate node schemas
  for (const node of graph.nodes) {
    if (node.config?.input_schema) {
      const validation = validateDataAgainstSchema({}, node.config.input_schema as JsonSchema, registry);
      if (!validation.valid) {
        errors.push({
          code: "INVALID_INPUT_SCHEMA",
          message: `Node ${node.id} has invalid input schema: ${validation.errors[0]?.message}`,
          path: `nodes.${node.id}.input_schema`,
        });
      }
    }

    if (node.config?.output_schema) {
      const validation = validateDataAgainstSchema({}, node.config.output_schema as JsonSchema, registry);
      if (!validation.valid) {
        errors.push({
          code: "INVALID_OUTPUT_SCHEMA",
          message: `Node ${node.id} has invalid output schema: ${validation.errors[0]?.message}`,
          path: `nodes.${node.id}.output_schema`,
        });
      }
    }
  }

  // Check for duplicate node IDs
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) {
      errors.push({
        code: "DUPLICATE_NODE_ID",
        message: `Duplicate node ID: ${node.id}`,
        path: `nodes.${node.id}`,
      });
    }
    nodeIds.add(node.id);
  }

  // Validate edges reference existing nodes
  for (const edge of graph.edges) {
    const source = (edge as any).source || (edge as any).from;
    const target = (edge as any).target || (edge as any).to;

    if (source && !nodeIds.has(source)) {
      errors.push({
        code: "UNKNOWN_EDGE_SOURCE",
        message: `Edge references unknown source node: ${source}`,
        path: `edges`,
      });
    }
    if (target && !nodeIds.has(target)) {
      errors.push({
        code: "UNKNOWN_EDGE_TARGET",
        message: `Edge references unknown target node: ${target}`,
        path: `edges`,
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── TypeScript Type Generation ───────────────────────────────────────

export function generateTypeScriptTypes(schema: JsonSchema, name: string): string {
  function generateType(schema: JsonSchema, indent: string): string {
    if (schema.$ref) {
      return schema.$ref;
    }

    if (schema.enum) {
      return schema.enum.map(v => JSON.stringify(v)).join(" | ");
    }

    if (schema.oneOf) {
      return schema.oneOf.map(s => generateType(s, indent)).join(" | ");
    }

    if (schema.anyOf) {
      return schema.anyOf.map(s => generateType(s, indent)).join(" | ");
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
          return `Array<${generateType(schema.items, indent)}>`;
        }
        return "unknown[]";
      case "object":
        if (!schema.properties && schema.additionalProperties === true) {
          return "Record<string, unknown>";
        }
        const lines: string[] = ["{"];
        const props = schema.properties || {};
        const required = new Set(schema.required || []);
        for (const [key, propSchema] of Object.entries(props)) {
          const isRequired = required.has(key);
          const type = generateType(propSchema, indent + "  ");
          lines.push(`${indent}  ${key}${isRequired ? "" : "?"}: ${type};`);
        }
        lines.push(`${indent}}`);
        return lines.join("\n");
      default:
        return "unknown";
    }
  }

  return `export interface ${name} ${generateType(schema, "")}`;
}
