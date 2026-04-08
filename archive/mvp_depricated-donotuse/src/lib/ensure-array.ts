/** Coerce unknown API payloads to an array (avoids `.filter is not a function` on objects). */
export function ensureArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
