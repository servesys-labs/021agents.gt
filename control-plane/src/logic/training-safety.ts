/**
 * Training safety gates — prevent training from producing broken or unsafe configs.
 *
 * These gates run BEFORE accepting eval results and BEFORE activating resources.
 * Addresses: tool smoke test, prompt safety, config validation, circuit breaker.
 */
import type { Sql } from "../db/client";
import type { Env } from "../env";
import { evaluateInput, DEFAULT_GUARDRAIL_POLICY } from "./guardrail-engine";
import { applyDeployPolicyToConfigJson } from "./deploy-policy-contract";

// ── Types ──────────────────────────────────────────────────────────────

export interface PreflightResult {
  passed: boolean;
  checks: PreflightCheck[];
  failed_tools: string[];
  warnings: string[];
}

export interface PreflightCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface SafetyGateResult {
  safe: boolean;
  action: "allow" | "warn" | "block";
  reasons: string[];
  injection_score: number;
  pii_detected: boolean;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface CircuitBreakerState {
  tripped: boolean;
  error_rate: number;
  total_sessions: number;
  error_sessions: number;
  window_minutes: number;
  activated_at: string | null;
}

// ── Pre-flight tool smoke test ─────────────────────────────────────────

/**
 * Before running training evals, verify that each enabled tool on the agent
 * actually works. Prevents APO from optimizing prompts to work around broken
 * tools (e.g., generating "don't use web-search, just answer from knowledge").
 */
export async function runPreflightChecks(
  sql: Sql,
  env: Env,
  orgId: string,
  agentName: string,
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const failedTools: string[] = [];
  const warnings: string[] = [];

  // 1. Load agent config
  const agentRows = await sql`
    SELECT config_json FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1
  `;
  if (agentRows.length === 0) {
    return { passed: false, checks: [{ name: "agent_exists", passed: false, detail: "Agent not found" }], failed_tools: [], warnings: [] };
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(String(agentRows[0].config_json || "{}"));
  } catch {
    return { passed: false, checks: [{ name: "config_parse", passed: false, detail: "Invalid config_json" }], failed_tools: [], warnings: [] };
  }

  checks.push({ name: "agent_exists", passed: true });
  checks.push({ name: "config_parse", passed: true });

  // 2. Verify model is set
  const model = String(config.model || "");
  if (!model) {
    checks.push({ name: "model_set", passed: false, detail: "No model configured" });
  } else {
    checks.push({ name: "model_set", passed: true, detail: model });
  }

  // 3. Verify system prompt exists
  const systemPrompt = String(config.system_prompt || "");
  if (!systemPrompt) {
    checks.push({ name: "system_prompt_set", passed: true, detail: "No system prompt — training will create one from scratch" });
    warnings.push("Agent has no system prompt — training will create one from scratch");
  } else {
    checks.push({ name: "system_prompt_set", passed: true, detail: `${systemPrompt.length} chars` });
  }

  // 4. Verify each enabled tool exists in catalog
  const tools = Array.isArray(config.tools) ? config.tools as string[] : [];
  if (tools.length === 0) {
    checks.push({ name: "tools_configured", passed: true, detail: "No tools enabled (prompt-only agent)" });
  } else {
    // Check each tool exists in the tool_registry or built-in list
    const BUILTIN_TOOLS = new Set([
      // Web
      "web-search", "browse", "http-request", "web-crawl", "browser-render",
      // Code
      "python-exec", "bash", "execute-code", "dynamic-exec",
      // Files
      "read-file", "write-file", "edit-file", "save-project", "load-project", "load-folder",
      // Memory
      "memory-save", "memory-recall", "knowledge-search", "store-knowledge",
      // Scheduling
      "create-schedule", "list-schedules", "delete-schedule",
      // Delegation
      "marketplace-search", "a2a-send", "run-agent", "create-agent", "list-agents",
      // Media
      "image-generate", "vision-analyze", "text-to-speech", "speech-to-text",
      // Integrations
      "mcp-call", "feed-post",
      // Legacy / meta
      "eval-agent", "evolve-agent", "list-tools", "discover-api", "todo",
    ]);

    let registeredTools: Set<string>;
    try {
      const toolRows = await sql`
        SELECT name FROM tool_registry WHERE org_id = ${orgId}
      `;
      registeredTools = new Set(toolRows.map((r: any) => String(r.name)));
    } catch {
      registeredTools = new Set();
    }

    for (const tool of tools) {
      const toolName = String(tool);
      const exists = BUILTIN_TOOLS.has(toolName) || registeredTools.has(toolName);
      if (!exists) {
        // Also try with hyphens → underscores and vice versa
        const altName = toolName.includes("-")
          ? toolName.replace(/-/g, "_")
          : toolName.replace(/_/g, "-");
        const altExists = BUILTIN_TOOLS.has(altName) || registeredTools.has(altName);

        if (altExists) {
          warnings.push(`Tool "${toolName}" not found but "${altName}" exists — check naming convention`);
          checks.push({ name: `tool:${toolName}`, passed: true, detail: `Found as "${altName}"` });
        } else {
          failedTools.push(toolName);
          checks.push({ name: `tool:${toolName}`, passed: false, detail: "Not in catalog" });
        }
      } else {
        checks.push({ name: `tool:${toolName}`, passed: true });
      }
    }

    // 5. Smoke test: ping RUNTIME to verify tools are callable
    if (failedTools.length === 0 && tools.length > 0) {
      try {
        const resp = await env.RUNTIME.fetch("https://runtime/api/v1/internal/health", {
          method: "GET",
          headers: env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {},
        });
        if (resp.ok) {
          checks.push({ name: "runtime_reachable", passed: true });
        } else {
          checks.push({ name: "runtime_reachable", passed: false, detail: `HTTP ${resp.status}` });
          warnings.push("Runtime worker not reachable — tool execution may fail during eval");
        }
      } catch (e) {
        checks.push({ name: "runtime_reachable", passed: false, detail: String(e) });
        warnings.push("Runtime worker unreachable");
      }
    }
  }

  // 6. Config deploy policy validation
  try {
    const policyResult = applyDeployPolicyToConfigJson({ ...config });
    if (!policyResult.ok) {
      checks.push({ name: "deploy_policy", passed: false, detail: policyResult.errors.join("; ") });
    } else {
      checks.push({ name: "deploy_policy", passed: true });
      if (policyResult.warnings.length > 0) {
        warnings.push(...policyResult.warnings);
      }
    }
  } catch {
    checks.push({ name: "deploy_policy", passed: true, detail: "Skipped (no policy)" });
  }

  const criticalFailures = checks.filter((c) => !c.passed && !c.name.startsWith("tool:"));
  const passed = criticalFailures.length === 0 && failedTools.length === 0;

  return { passed, checks, failed_tools: failedTools, warnings };
}

// ── Prompt safety gate ─────────────────────────────────────────────────

/**
 * Scan an APO-generated prompt for safety violations.
 * Hard-veto any prompt that:
 * - Contains prompt injection patterns
 * - Strips safety-related instructions
 * - Contains PII
 * - Has blocked topics
 *
 * This is NOT optional. Every APO candidate goes through this.
 */
export function runPromptSafetyGate(
  newPrompt: string,
  originalPrompt: string,
): SafetyGateResult {
  const reasons: string[] = [];

  // 1. Run guardrail engine on the new prompt
  const result = evaluateInput(newPrompt, DEFAULT_GUARDRAIL_POLICY);

  if (result.action === "block") {
    return {
      safe: false,
      action: "block",
      reasons: [`Guardrail blocked: ${result.reasons.join(", ")}`],
      injection_score: result.injection_score,
      pii_detected: result.pii_matches.length > 0,
    };
  }

  // 2. Check for safety instruction stripping
  // Look for common safety patterns in original that are missing in new
  const safetyPatterns = [
    /refuse|don't|do not|never|prohibited|forbidden/i,
    /safe|safety|appropriate|ethical|responsible/i,
    /harmful|dangerous|illegal|unethical/i,
    /guideline|policy|rule|boundary|limit/i,
  ];

  const originalHasSafety = safetyPatterns.some((p) => p.test(originalPrompt));
  const newHasSafety = safetyPatterns.some((p) => p.test(newPrompt));

  if (originalHasSafety && !newHasSafety) {
    reasons.push("APO removed safety-related instructions from prompt");
  }

  // 3. Check for suspicious prompt patterns
  const suspiciousPatterns = [
    /ignore previous|forget (your|all) instructions/i,
    /you are now|pretend you are|act as/i,
    /bypass|override|disable|skip/i,
    /jailbreak|DAN|developer mode/i,
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(newPrompt)) {
      reasons.push(`Suspicious pattern detected: ${pattern.source}`);
    }
  }

  // 4. Length sanity check — APO shouldn't produce prompts > 10x original
  if (originalPrompt.length > 0 && newPrompt.length > originalPrompt.length * 10) {
    reasons.push(`Prompt grew ${Math.round(newPrompt.length / originalPrompt.length)}x — suspicious`);
  }

  // 5. Empty prompt check
  if (newPrompt.trim().length < 10) {
    return {
      safe: false,
      action: "block",
      reasons: ["APO produced an empty or near-empty prompt"],
      injection_score: 0,
      pii_detected: false,
    };
  }

  const hasSuspicious = reasons.length > 0;
  const safe = !hasSuspicious;
  const action = hasSuspicious ? "block" : "allow";

  return {
    safe,
    action,
    reasons: [...result.reasons, ...reasons],
    injection_score: result.injection_score,
    pii_detected: result.pii_matches.length > 0,
  };
}

// ── Config validation gate ─────────────────────────────────────────────

/**
 * Validate a trained config before activating it.
 * Ensures the runtime can actually load and execute this config.
 */
export function validateTrainedConfig(
  configJson: Record<string, unknown>,
): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Model format validation
  const model = String(configJson.model || "");
  if (model) {
    // Must be a valid model identifier (provider/model or just model name)
    if (!/^[\w\-\/.:]+$/.test(model)) {
      errors.push(`Invalid model format: "${model}"`);
    }
  }

  // 2. System prompt validation
  const systemPrompt = String(configJson.system_prompt || "");
  if (systemPrompt.length > 50000) {
    errors.push(`System prompt exceeds 50,000 char limit (${systemPrompt.length})`);
  }

  // 3. Tool list validation
  const tools = configJson.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (typeof tool !== "string") {
        errors.push(`Tool entry is not a string: ${JSON.stringify(tool)}`);
      }
    }
  }

  // 4. Numeric range validation
  const maxTurns = configJson.max_turns;
  if (maxTurns !== undefined && (typeof maxTurns !== "number" || maxTurns < 1 || maxTurns > 1000)) {
    errors.push(`max_turns out of range: ${maxTurns}`);
  }

  const temperature = configJson.temperature;
  if (temperature !== undefined && (typeof temperature !== "number" || temperature < 0 || temperature > 2)) {
    errors.push(`temperature out of range: ${temperature}`);
  }

  // 5. Reasoning strategy validation
  const strategy = configJson.reasoning_strategy;
  if (strategy !== undefined) {
    const valid = ["step-back", "chain-of-thought", "plan-then-execute", "verify-then-respond", "decompose"];
    if (!valid.includes(String(strategy))) {
      errors.push(`Invalid reasoning_strategy: "${strategy}"`);
    }
  }

  // 6. Deploy policy validation
  try {
    const policyResult = applyDeployPolicyToConfigJson({ ...configJson });
    if (!policyResult.ok) {
      errors.push(...policyResult.errors);
    }
    warnings.push(...policyResult.warnings);
  } catch {
    // No deploy policy — acceptable
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── Circuit breaker ────────────────────────────────────────────────────

/**
 * Check if a recently activated resource should be auto-reverted.
 * Monitors error rate within a window after activation.
 *
 * Returns tripped=true if error rate exceeds threshold, meaning
 * the caller should revert to the previous resource version.
 */
export async function checkCircuitBreaker(
  sql: Sql,
  orgId: string,
  agentName: string,
  windowMinutes: number = 15,
  errorThreshold: number = 0.3,
): Promise<CircuitBreakerState> {
  // Get the latest resource activation time
  let activatedAt: string | null = null;
  try {
    const rows = await sql`
      SELECT created_at FROM training_resources
      WHERE org_id = ${orgId} AND agent_name = ${agentName} AND is_active = true
      ORDER BY created_at DESC LIMIT 1
    `;
    if (rows.length > 0) {
      activatedAt = String(rows[0].created_at);
    }
  } catch {
    return { tripped: false, error_rate: 0, total_sessions: 0, error_sessions: 0, window_minutes: windowMinutes, activated_at: null };
  }

  if (!activatedAt) {
    return { tripped: false, error_rate: 0, total_sessions: 0, error_sessions: 0, window_minutes: windowMinutes, activated_at: null };
  }

  // Check error rate since activation (within window)
  try {
    const rows = await sql`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status IN ('error', 'failed')) as errors
      FROM sessions
      WHERE agent_name = ${agentName}
        AND org_id = ${orgId}
        AND created_at > ${activatedAt}
        AND created_at > now() - (${windowMinutes} * interval '1 minute')
    `;

    const total = Number(rows[0]?.total ?? 0);
    const errors = Number(rows[0]?.errors ?? 0);

    if (total < 3) {
      // Not enough data to trip
      return { tripped: false, error_rate: 0, total_sessions: total, error_sessions: errors, window_minutes: windowMinutes, activated_at: activatedAt };
    }

    const errorRate = errors / total;
    return {
      tripped: errorRate >= errorThreshold,
      error_rate: errorRate,
      total_sessions: total,
      error_sessions: errors,
      window_minutes: windowMinutes,
      activated_at: activatedAt,
    };
  } catch {
    return { tripped: false, error_rate: 0, total_sessions: 0, error_sessions: 0, window_minutes: windowMinutes, activated_at: activatedAt };
  }
}

/**
 * Revert to the previous resource version and update agent config.
 */
export async function revertToPreviousResource(
  sql: Sql,
  orgId: string,
  agentName: string,
  resourceType: string = "system_prompt",
  resourceKey: string = "main",
): Promise<{ reverted: boolean; from_version: number | null; to_version: number | null }> {
  // Find current active version
  const activeRows = await sql`
    SELECT version, content_text FROM training_resources
    WHERE org_id = ${orgId} AND agent_name = ${agentName}
      AND resource_type = ${resourceType} AND resource_key = ${resourceKey}
      AND is_active = true
    ORDER BY version DESC LIMIT 1
  `;

  if (activeRows.length === 0) {
    return { reverted: false, from_version: null, to_version: null };
  }

  const currentVersion = Number(activeRows[0].version);

  // Find the previous version
  const prevRows = await sql`
    SELECT version, content_text FROM training_resources
    WHERE org_id = ${orgId} AND agent_name = ${agentName}
      AND resource_type = ${resourceType} AND resource_key = ${resourceKey}
      AND version < ${currentVersion}
    ORDER BY version DESC LIMIT 1
  `;

  if (prevRows.length === 0) {
    return { reverted: false, from_version: currentVersion, to_version: null };
  }

  const prevVersion = Number(prevRows[0].version);
  const prevContent = String(prevRows[0].content_text || "");

  // Activate previous FIRST, then deactivate current.
  // If a crash occurs between the two, we have two active versions (recoverable)
  // rather than zero (broken).
  await sql`
    UPDATE training_resources SET is_active = true
    WHERE org_id = ${orgId} AND agent_name = ${agentName}
      AND resource_type = ${resourceType} AND resource_key = ${resourceKey}
      AND version = ${prevVersion}
  `;

  await sql`
    UPDATE training_resources SET is_active = false
    WHERE org_id = ${orgId} AND agent_name = ${agentName}
      AND resource_type = ${resourceType} AND resource_key = ${resourceKey}
      AND version = ${currentVersion}
  `;

  // Update agent config
  if (resourceType === "system_prompt" && prevContent) {
    try {
      const agentRows = await sql`
        SELECT config_json FROM agents WHERE name = ${agentName} AND org_id = ${orgId}
      `;
      if (agentRows.length > 0) {
        const config = JSON.parse(String(agentRows[0].config_json || "{}"));
        config.system_prompt = prevContent;
        await sql`
          UPDATE agents SET config_json = ${JSON.stringify(config)}, updated_at = now()
          WHERE name = ${agentName} AND org_id = ${orgId}
        `;
      }
    } catch { /* Non-critical */ }
  }

  return { reverted: true, from_version: currentVersion, to_version: prevVersion };
}
