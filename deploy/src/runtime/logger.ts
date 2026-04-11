/**
 * Phase 7.4: Structured JSONL Event Logging
 *
 * Per-request JsonlLogger instances capture enriched, queryable events and
 * drain them to KV as JSONL. The old module-level singleton was unsafe:
 * concurrent requests on the same Worker isolate overwrote each other's
 * context, leaking org_id/session_id across tenants and writing logs to the
 * wrong KV key. `JsonlLogger` is now instantiated per-workflow and passed
 * explicitly; the module-level `log` shim (see ./log.ts) handles
 * general-purpose logging and mirrors to `console.*` so nothing is lost.
 */

import type { RuntimeEnv } from "./types";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  session_id?: string;
  trace_id?: string;
  org_id?: string;
  agent_name?: string;
}

export interface LogEntry extends LogContext {
  timestamp: number;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

const MAX_BUFFER = 50;
const FLUSH_INTERVAL_MS = 1000;

/**
 * Structured logger that buffers entries and flushes to KV as JSONL.
 * One instance per workflow run. Not shared across requests.
 */
export class JsonlLogger {
  private buffer: LogEntry[] = [];
  private readonly context: LogContext;
  private readonly env: RuntimeEnv | null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushSeq = 0;

  constructor(env: RuntimeEnv | null, context: LogContext) {
    this.env = env;
    this.context = { ...context };
  }

  log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      event,
      ...this.context,
      ...data,
    };
    this.buffer.push(entry);

    // Always mirror to console so wrangler tail / CI logs see the event
    // even if the KV flush later fails.
    const tag = `[${this.context.session_id || "-"}]`;
    const payload = data ? ` ${JSON.stringify(data)}` : "";
    const line = `${tag} ${event}${payload}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);

    if (this.buffer.length >= MAX_BUFFER) {
      // Fire-and-forget: the caller is not awaiting us.
      void this.flush();
    } else if (!this.flushTimer && this.env) {
      this.flushTimer = setTimeout(() => { void this.flush(); }, FLUSH_INTERVAL_MS);
    }
  }

  info(event: string, data?: Record<string, unknown>): void { this.log("info", event, data); }
  warn(event: string, data?: Record<string, unknown>): void { this.log("warn", event, data); }
  error(event: string, data?: Record<string, unknown>): void { this.log("error", event, data); }

  /**
   * Drain the buffer to KV. Uses a unique per-batch suffix so concurrent
   * flushes never clobber each other via read-modify-write on a shared key.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length === 0 || !this.env) return;

    const entries = this.buffer.splice(0);
    const kv = (this.env as { AGENT_PROGRESS_KV?: KVNamespace }).AGENT_PROGRESS_KV;
    if (!kv) return;

    const jsonl = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
    const date = new Date().toISOString().slice(0, 10);
    const org = this.context.org_id || "default";
    const session = this.context.session_id || "unknown";
    const seq = (++this.flushSeq).toString(36).padStart(4, "0");
    const rand = Math.random().toString(36).slice(2, 8);
    // One KV object per batch keeps flushes lock-free.
    const key = `logs/${org}/${date}/${session}/${Date.now()}-${seq}-${rand}.jsonl`;

    try {
      await kv.put(key, jsonl, { expirationTtl: 86400 * 7 }); // 7 day TTL
    } catch {
      // Best-effort — console mirror already captured the event.
    }
  }
}

/**
 * Create a fresh JsonlLogger bound to a single request/workflow.
 * Consumers must own the lifecycle: call `flush()` at request end.
 */
export function createJsonlLogger(env: RuntimeEnv | null, context: LogContext): JsonlLogger {
  return new JsonlLogger(env, context);
}
