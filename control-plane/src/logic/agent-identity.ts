const RESERVED_PLATFORM_AGENT_HANDLES = new Set([
  "memory-agent",
  "meta-agent",
]);

function titleCaseToken(token: string): string {
  if (!token) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

export function normalizeAgentHandle(raw: string): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
}

export function defaultDisplayNameFromHandle(handle: string): string {
  const normalized = normalizeAgentHandle(handle);
  if (!normalized) return "";
  return normalized
    .split("-")
    .filter(Boolean)
    .map(titleCaseToken)
    .join(" ");
}

export function buildAgentIdentity(input: {
  handle?: string;
  displayName?: string;
  fallbackHandle?: string;
}): {
  handle: string;
  displayName: string;
} {
  const handle = normalizeAgentHandle(input.handle || input.fallbackHandle || "");
  if (!handle) {
    throw new Error("agent handle is required");
  }
  const displayName = String(input.displayName || "").trim().slice(0, 160) || defaultDisplayNameFromHandle(handle);
  return { handle, displayName };
}

export function isReservedPlatformAgentHandle(handle: string): boolean {
  return RESERVED_PLATFORM_AGENT_HANDLES.has(normalizeAgentHandle(handle));
}

export function getReservedPlatformAgentHandles(): string[] {
  return [...RESERVED_PLATFORM_AGENT_HANDLES];
}

export function isHiddenAgentConfig(config: Record<string, unknown>): boolean {
  return config.internal === true
    || config.hidden === true
    || config.visibility === "hidden"
    || (typeof config.parent_agent === "string" && config.parent_agent.trim().length > 0);
}

export function decorateAgentConfigIdentity(
  config: Record<string, unknown>,
  identity: {
    agentId?: string;
    handle: string;
    displayName: string;
  },
): Record<string, unknown> {
  return {
    ...config,
    agent_id: identity.agentId || config.agent_id || "",
    handle: identity.handle,
    name: identity.handle,
    display_name: identity.displayName,
  };
}
