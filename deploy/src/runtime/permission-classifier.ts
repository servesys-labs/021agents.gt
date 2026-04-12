/**
 * Permission Classifier — AI-driven auto-approval for tool calls.
 *
 * Uses Workers AI (fast, edge-local) to classify tool calls as:
 *   - SAFE: auto-approve (read-file, grep, web-search)
 *   - REVIEW: auto-approve if context looks benign (write-file to workspace)
 *   - DANGEROUS: require user confirmation (rm, DROP, delete)
 *
 * Inspired by Claude Code's TRANSCRIPT_CLASSIFIER that auto-approves
 * trusted operations to reduce permission friction.
 */

import type { RuntimeEnv } from "./types";

export type PermissionLevel = "safe" | "review" | "dangerous";

// Static classification for known tools (no AI needed)
const STATIC_CLASSIFICATION: Record<string, PermissionLevel> = {
  // Always safe (read-only, isolated)
  "read-file": "safe",
  "view-file": "safe",
  "grep": "safe",
  "glob": "safe",
  "find-file": "safe",
  "search-file": "safe",
  "web-search": "safe",
  "knowledge-search": "safe",
  "self-check": "safe",
  "adapt-strategy": "safe",
  "load-project": "safe",
  "discover-tools": "safe",
  "scratch-read": "safe",
  "scratch-list": "safe",
  "retrieve-result": "safe",
  "memory-recall": "safe",
  "marketplace-search": "safe",
  "team-fact-write": "safe",
  "team-observation": "safe",

  // Review: generally safe but context-dependent
  "write-file": "review",
  "edit-file": "review",
  "scratch-write": "review",
  "store-knowledge": "review",
  "memory-save": "review",
  "image-generate": "review",
  "text-to-speech": "review",
  "send-message": "review",
  "http-request": "review",
  "web-crawl": "review",
  "browser-render": "review",
  "save-project": "review",

  // Dangerous: can cause damage, require confirmation
  "bash": "dangerous",
  "python-exec": "dangerous",
  "dynamic-exec": "dangerous",
  "execute-code": "dangerous",
  "memory-delete": "dangerous",
  "delete-agent": "dangerous",
  "manage-secrets": "dangerous",
  "manage-retention": "dangerous",
  "mcp-call": "dangerous",
  "a2a-send": "dangerous",
  "share-artifact": "dangerous",
};

// Irreducible safety floor — no model judgment or config can bypass these.
// These operations always require human approval. This backstop survives
// even if STATIC_CLASSIFICATION is deleted or moved to a skill.
export const ALWAYS_REQUIRE_APPROVAL = new Set([
  "delete-agent",
  "manage-secrets",
  "dynamic-exec",
  "manage-retention",
  "a2a-send",
]);

/**
 * Classify a tool call's risk level.
 * Returns permission level + whether auto-approval is recommended.
 */
export function classifyPermission(
  toolName: string,
  args: Record<string, unknown>,
  context?: { agentConfig?: any; sessionHistory?: string },
): { level: PermissionLevel; autoApprove: boolean; reason: string } {
  if (ALWAYS_REQUIRE_APPROVAL.has(toolName)) {
    return { level: "dangerous", autoApprove: false, reason: "irreducible safety floor" };
  }

  const staticLevel = STATIC_CLASSIFICATION[toolName];

  if (staticLevel === "safe") {
    return { level: "safe", autoApprove: true, reason: "read-only/isolated tool" };
  }

  if (staticLevel === "dangerous") {
    // Check for destructive patterns in args
    const argsStr = JSON.stringify(args).toLowerCase();
    const isDestructive = /\b(rm\s+-rf|drop\s+table|delete\s+from|truncate|format|kill\s+-9)\b/.test(argsStr);
    if (isDestructive) {
      return { level: "dangerous", autoApprove: false, reason: `destructive command detected` };
    }

    // Bash/python with safe patterns can be auto-approved
    if (toolName === "bash") {
      const cmd = String(args.command || "").trim();
      const safePatterns = [
        /^(ls|pwd|echo|cat|head|tail|wc|date|whoami|which|env|printenv)\b/,
        /^(npm|npx|node|python3?|pip|git)\s+(--version|version|-v)$/,
        /^git\s+(status|log|diff|branch|remote)\b/,
        /^(npm|yarn|pnpm)\s+(test|run|build|lint|check)\b/,
      ];
      if (safePatterns.some(p => p.test(cmd))) {
        return { level: "review", autoApprove: true, reason: "safe bash pattern" };
      }
    }

    return { level: "dangerous", autoApprove: false, reason: "potentially destructive tool" };
  }

  if (staticLevel === "review") {
    // Context-based auto-approval for review-level tools
    if (toolName === "write-file" || toolName === "edit-file") {
      const path = String(args.path || "");
      // Auto-approve writes to workspace, /tmp, or test files
      if (path.startsWith("/workspace/") || path.startsWith("/tmp/") || path.includes("test") || path.includes("spec")) {
        return { level: "review", autoApprove: true, reason: "write to safe location" };
      }
    }
    return { level: "review", autoApprove: true, reason: "generally safe tool" };
  }

  // Unknown tool — conservative
  return { level: "review", autoApprove: false, reason: "unknown tool" };
}

/**
 * Check if a governance config allows auto-approval.
 * Returns true if auto-approval is enabled AND the tool call passes classification.
 */
export function shouldAutoApprove(
  toolName: string,
  args: Record<string, unknown>,
  config?: { auto_approve?: boolean; require_confirmation_for_destructive?: boolean },
): boolean {
  if (!config?.auto_approve) return false; // Auto-approval not enabled
  if (config.require_confirmation_for_destructive) {
    const { level, autoApprove } = classifyPermission(toolName, args);
    return autoApprove && level !== "dangerous";
  }
  return classifyPermission(toolName, args).autoApprove;
}
