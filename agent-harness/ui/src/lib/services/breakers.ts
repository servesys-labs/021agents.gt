/**
 * Circuit breaker snapshot for the canvas LiveStatsPanel.
 *
 * Hits GET /api/v1/runtime-proxy/breakers, which proxies to the edge
 * runtime's /api/v1/runtime/breakers and aggregates DB + tools + LLM
 * breaker state. Degraded responses (runtime unreachable) set `degraded`
 * and return conservative all-closed values so the UI doesn't flash red
 * on a single blip.
 */

import { api } from "./api";

export type BreakerState = "closed" | "half-open" | "open";

export interface BreakersSnapshot {
  db: {
    state: BreakerState;
    failures: number;
    opened_at: number | null;
  };
  llm: {
    state: BreakerState;
    failures?: number;
    opened_at?: number | null;
    last_failure_at?: number | null;
    last_error?: string | null;
    /** Present on the control-plane fallback snapshot only. */
    note?: string;
  };
  tools: {
    state: BreakerState;
    total_tools_tracked: number;
    open_count: number;
    half_open_count: number;
    worst_tools: Array<{ name: string; state: string; failures: number }>;
  };
  timestamp: number;
  degraded?: boolean;
  error?: string;
}

export function fetchBreakers(): Promise<BreakersSnapshot> {
  return api.get<BreakersSnapshot>("/runtime-proxy/breakers");
}
