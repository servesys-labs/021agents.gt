/**
 * Cloud Pattern C3.2: WebSocket Reconnection Dedup
 *
 * Problem: When a client reconnects to a DO WebSocket, all KV progress
 * events are replayed from scratch. No seq-num cursor means duplicate
 * events flood the client.
 *
 * Solution: Seq-num cursor tracking per connection. On reconnect, client
 * sends `from_seq` and only events after that seq are sent.
 *
 * Inspired by Claude Code's UUID dedup + seq-num carryover in bridgeMessaging.ts.
 */

// ── Bounded UUID Set for echo detection ────────────────────────────

export class BoundedUUIDSet {
  private set = new Set<string>();
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  has(uuid: string): boolean {
    return this.set.has(uuid);
  }

  add(uuid: string): void {
    this.set.add(uuid);
    if (this.set.size > this.maxSize) {
      // Evict oldest (first inserted)
      const first = this.set.values().next().value;
      if (first !== undefined) this.set.delete(first);
    }
  }

  get size(): number {
    return this.set.size;
  }
}

// ── Seq-Num Event Dedup ────────────────────────────────────────────

export interface SeqEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

/**
 * EventSequencer assigns monotonic sequence numbers to events
 * and supports replay from a given cursor.
 */
export class EventSequencer {
  private events: SeqEvent[] = [];
  private nextSeq = 1;
  private maxEvents: number;

  constructor(maxEvents: number = 500) {
    this.maxEvents = maxEvents;
  }

  /**
   * Add an event and assign a sequence number.
   */
  push(type: string, data: Record<string, unknown>): SeqEvent {
    const event: SeqEvent = {
      seq: this.nextSeq++,
      type,
      data,
      timestamp: Date.now(),
    };
    this.events.push(event);
    // Evict oldest when over capacity
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-Math.floor(this.maxEvents * 0.75));
    }
    return event;
  }

  /**
   * Get all events after a given sequence number.
   * Used for client reconnect: client sends `from_seq`, gets only new events.
   *
   * Returns { events, resyncRequired }. If the requested seq is below our
   * minimum retained seq, a full resync is needed (events were evicted).
   */
  getAfter(fromSeq: number): { events: SeqEvent[]; resyncRequired: boolean } {
    const minSeq = this.events.length > 0 ? this.events[0].seq : 0;
    if (fromSeq > 0 && fromSeq < minSeq) {
      // Requested events were evicted — client needs full resync
      return { events: this.events, resyncRequired: true };
    }
    return { events: this.events.filter(e => e.seq > fromSeq), resyncRequired: false };
  }

  /**
   * Get the latest sequence number.
   * Client stores this and sends it on reconnect.
   */
  getLatestSeq(): number {
    return this.nextSeq - 1;
  }

  /**
   * Get total event count (for diagnostics).
   */
  getCount(): number {
    return this.events.length;
  }
}

// ── KV Event Compaction (C3.3) ─────────────────────────────────────

/**
 * Compact KV progress events for a session.
 * Removes intermediate events (tool_progress, heartbeat) and keeps
 * only structural events (session_start, turn_start/end, tool_call/result, done, error).
 *
 * Reduces KV storage from potentially thousands of entries to ~50 per session.
 */
export async function compactProgressEvents(
  kv: any,
  progressKey: string,
): Promise<{ before: number; after: number }> {
  if (!kv) return { before: 0, after: 0 };

  try {
    const raw = await kv.get(progressKey);
    if (!raw) return { before: 0, after: 0 };

    const events: any[] = JSON.parse(raw);
    const before = events.length;

    // Keep only structural events
    const KEEP_TYPES = new Set([
      "session_start", "turn_start", "turn_end",
      "tool_call", "tool_result",
      "done", "error", "warning", "file_change",
    ]);

    const compacted = events.filter((e: any) => KEEP_TYPES.has(e.type));

    // Only write back if significant reduction
    if (compacted.length < before * 0.8) {
      await kv.put(progressKey, JSON.stringify(compacted), {
        expirationTtl: 7200, // 2h TTL on compacted events
      });
    }

    return { before, after: compacted.length };
  } catch {
    return { before: 0, after: 0 };
  }
}
