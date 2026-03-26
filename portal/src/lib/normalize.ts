export function extractList<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (!payload || typeof payload !== "object") return [];

  const record = payload as Record<string, unknown>;
  const value = record[key];
  return Array.isArray(value) ? (value as T[]) : [];
}
