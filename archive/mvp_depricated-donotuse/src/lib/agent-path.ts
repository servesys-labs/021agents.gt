/**
 * Return the URL-safe path segment for an agent.
 * Prefers agent_id (stable, opaque) over name (can contain spaces/unicode).
 * Falls back to encoding the name if no ID is available.
 */
export function agentPathSegment(agentIdOrName: string): string {
  return encodeURIComponent(agentIdOrName.trim());
}
