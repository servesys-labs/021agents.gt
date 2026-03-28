/** Encode agent display name for use in URL path segments (spaces, unicode, etc.). */
export function agentPathSegment(name: string): string {
  return encodeURIComponent(name.trim());
}
