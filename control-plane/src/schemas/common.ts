/**
 * Shared Zod schemas — pagination, error responses, common types.
 */
import { z } from "zod";

export const PaginationParams = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PaginationParams = z.infer<typeof PaginationParams>;

export const PaginatedResponse = z.object({
  data: z.array(z.record(z.unknown())),
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
});

export const ErrorResponse = z.object({
  error: z.string(),
  detail: z.string().optional(),
});

/** Helper to build a paginated response. */
export function paginated<T>(data: T[], total: number, offset: number, limit: number) {
  return { data, total, offset, limit };
}

/** Parse agents.config_json (or legacy stringified blobs) — never throws. */
export function parseAgentConfigJson(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}
