/**
 * Phase 7.4: Structured JSONL Event Logging
 *
 * Buffered, enriched, queryable logs in KV. When telemetry queue is
 * unavailable, events aren't lost — they persist in KV for later drain.
 *
 * Inspired by Claude Code's JSONL error logger with buffered writes
 * and automatic enrichment.
 */

import type { RuntimeEnv } from "./types";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  event: string;
  session_id?: string;
  trace_id?: string;
  org_id?: string;
  agent_name?: string;
  [key: string]: unknown;
}

const MAX_BUFFER = 50;
const FLUSH_INTERVAL_MS = 1000;

/**
 * Structured logger that buffers entries and flushes to KV as JSONL.
 */
export class JsonlLogger {
  private buffer: LogEntry[] = [];
  private context: {
    session_id?: string;
    trace_id?: string;
    org_id?: string;
    agent_name?: string;
  } = {};
  private env: RuntimeEnv | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Initialize logger with session context.
   */
  init(env: RuntimeEnv, context: typeof this.context): void {
    this.env = env;
    this.context = context;
  }

  /**
   * Log a structured event.
   */
  log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      event,
      ...this.context,
      ...data,
    };
    this.buffer.push(entry);

    if (this.buffer.length >= MAX_BUFFER) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  info(event: string, data?: Record<string, unknown>): void { this.log("info", event, data); }
  warn(event: string, data?: Record<string, unknown>): void { this.log("warn", event, data); }
  error(event: string, data?: Record<string, unknown>): void { this.log("error", event, data); }

  /**
   * Flush buffer to KV as JSONL.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length === 0 || !this.env) return;

    const entries = this.buffer.splice(0);
    const kv = (this.env as any).AGENT_PROGRESS_KV;
    if (!kv) return;

    const jsonl = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
    const date = new Date().toISOString().slice(0, 10);
    const key = `logs/${this.context.org_id || "default"}/${date}/${this.context.session_id || "unknown"}.jsonl`;

    try {
      // Append to existing log (read + concat + write)
      const existing = await kv.get(key) || "";
      await kv.put(key, existing + jsonl, { expirationTtl: 86400 * 7 }); // 7 day TTL
    } catch {
      // Best-effort — don't block agent execution
    }
  }
}

/** Singleton logger instance per session */
export const logger = new JsonlLogger();
