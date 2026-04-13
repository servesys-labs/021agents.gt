/**
 * AgentOS Signals Worker — Signal Ingestion & Processing
 *
 * Composable building block: consumes signal events from the
 * agentos-signals queue, processes them, and writes to the
 * SignalCoordinatorDO for clustering and rule evaluation.
 *
 * Phase 1 (current): Thin proxy — forwards queue messages to Agent Core
 * which still hosts the SignalCoordinatorDO and processing logic.
 *
 * Phase 2 (next): Move SignalCoordinatorDO, signal-rule-packs,
 * signal-rules-memory, and the full queue processing logic here.
 * Agent Core only produces to the queue; this worker does all
 * signal processing independently.
 */

export interface Env {
  // Service binding to agent core for DO access (Phase 1)
  AGENT_CORE: Fetcher;
  // Hyperdrive for signal metadata persistence
  HYPERDRIVE: Hyperdrive;
  // Analytics Engine for signal metrics
  SIGNAL_ANALYTICS: AnalyticsEngineDataset;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "signals" });
    }

    // Phase 2: will expose /api/signals/snapshot, /api/signals/ingest endpoints

    return Response.json({ error: "Not found" }, { status: 404 });
  },

  // ── Queue consumer: signal events from agentos-signals ──
  // Phase 1: Forward to Agent Core which still has the processing logic.
  // Phase 2: Process signals directly (cluster, evaluate rules, fire workflows).
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const msg of batch) {
      try {
        const payload = msg.body as Record<string, unknown>;

        // Forward to Agent Core's internal signal ingestion endpoint
        const resp = await env.AGENT_CORE.fetch(
          new Request("http://internal/signals/ingest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
        );

        if (resp.ok) {
          msg.ack();
        } else {
          msg.retry();
        }
      } catch {
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
