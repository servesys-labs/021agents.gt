/**
 * Safely read a database column that may be jsonb (object) or text (string).
 * After migration 031, all *_json columns are jsonb, so the postgres driver
 * returns them as objects. This helper handles both cases for backwards compat.
 */
export function parseJsonColumn<T = any>(val: unknown, fallback?: T): T {
  if (val == null) return (fallback ?? {}) as T;
  if (typeof val === "object") return val as T;
  try { return JSON.parse(val as string); } catch { return (fallback ?? {}) as T; }
}
