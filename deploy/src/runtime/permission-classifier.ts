/**
 * Permission Classifier — deterministic safety floor for tool calls.
 *
 * Simplified from the original static classification table (Phase 9.4).
 * The full policy table (safe/review/dangerous categories) is now in
 * skills/meta/classify-permission/SKILL.md for the meta-agent to read
 * when advising users. This file retains only the irreducible
 * deterministic checks that no model judgment can bypass.
 */

export type PermissionLevel = "safe" | "review" | "dangerous";

// Irreducible safety floor — no model judgment or config can bypass these.
export const ALWAYS_REQUIRE_APPROVAL = new Set([
  "delete-agent",
  "manage-secrets",   // backward compat (pre-v1.3 configs)
  "dynamic-exec",
  "manage-retention", // backward compat (pre-v1.3 configs)
  "a2a-send",
]);

// Resource-level checks for the consolidated "platform" verb.
const DANGEROUS_PLATFORM_RESOURCES = new Set(["secrets", "retention"]);

const DESTRUCTIVE_PATTERN = /\b(rm\s+-rf|drop\s+table|delete\s+from|truncate|format|kill\s+-9)\b/i;

/**
 * Classify a tool call's risk level. Three deterministic checks:
 * 1. ALWAYS_REQUIRE_APPROVAL — hardcoded catastrophic operations
 * 2. Platform verb with dangerous resource (secrets, retention)
 * 3. Destructive pattern regex — catches rm -rf, DROP TABLE, etc.
 * Everything else is allowed through.
 */
export function classifyPermission(
  toolName: string,
  args: Record<string, unknown>,
  _context?: { agentConfig?: any; sessionHistory?: string },
): { level: PermissionLevel; autoApprove: boolean; reason: string } {
  if (ALWAYS_REQUIRE_APPROVAL.has(toolName)) {
    return { level: "dangerous", autoApprove: false, reason: "irreducible safety floor" };
  }

  // Consolidated "platform" verb: check resource-level danger
  if (toolName === "platform" && DANGEROUS_PLATFORM_RESOURCES.has(String(args.resource || ""))) {
    return { level: "dangerous", autoApprove: false, reason: "irreducible safety floor" };
  }

  const argsStr = JSON.stringify(args).toLowerCase();
  if (DESTRUCTIVE_PATTERN.test(argsStr)) {
    return { level: "dangerous", autoApprove: false, reason: "destructive command detected" };
  }

  return { level: "review", autoApprove: true, reason: "default allow" };
}

/**
 * Check if a governance config allows auto-approval.
 */
export function shouldAutoApprove(
  toolName: string,
  args: Record<string, unknown>,
  config?: { auto_approve?: boolean; require_confirmation_for_destructive?: boolean },
): boolean {
  if (!config?.auto_approve) return false;
  if (config.require_confirmation_for_destructive) {
    const { autoApprove } = classifyPermission(toolName, args);
    return autoApprove;
  }
  return classifyPermission(toolName, args).autoApprove;
}
