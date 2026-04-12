/**
 * Runtime mock worker for load testing.
 *
 * Deployed as `agentos-runtime-loadtest` — a separate worker that the
 * control-plane's RUNTIME service binding points at during load tests.
 * Returns canned responses with configurable latency to isolate
 * control-plane performance from LLM inference time.
 *
 * Two modes:
 * - Normal: 50-200ms uniform random latency (simulates realistic runtime)
 * - Zero-latency: 0ms delay (Scenario A variant for pure DB saturation testing)
 *
 * The response shape matches what the real runtime returns so the
 * control-plane's billing, session-write, and response-formatting
 * paths exercise identically.
 */

interface Env {
  MOCK_LATENCY_MIN_MS: string;
  MOCK_LATENCY_MAX_MS: string;
  MOCK_COST_USD: string;
  ZERO_LATENCY_MODE: string;
}

const CANNED_OUTPUTS = [
  "Based on my analysis, here are the key findings from your agent's recent activity. Performance metrics are within normal ranges, with an average response time of 2.3 seconds. No critical errors detected in the last 24 hours.",
  "I've reviewed the data and found 3 areas for improvement: (1) response latency during peak hours, (2) tool execution retry rate, and (3) context window utilization. Shall I elaborate on any of these?",
  "The health check shows all systems operational. Database connections are healthy, the queue is processing normally, and credit balance is sufficient for continued operation.",
  "Here's a summary of today's activity: 47 sessions completed, 2 failed (both timeout-related), average cost per session $0.08, total spend $3.76. No anomalies detected.",
  "Analysis complete. The agent is performing within expected parameters. I recommend monitoring the elevated error rate on the http-request tool — it increased from 2% to 4% over the last 6 hours.",
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only handle POST /run (the path the control-plane's RUNTIME.fetch uses)
    const url = new URL(request.url);
    if (request.method !== "POST" || !url.pathname.endsWith("/run")) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body: Record<string, unknown> = {};
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {}

    // Configurable latency
    const zeroLatency = env.ZERO_LATENCY_MODE === "1";
    if (!zeroLatency) {
      const minMs = parseInt(env.MOCK_LATENCY_MIN_MS || "50");
      const maxMs = parseInt(env.MOCK_LATENCY_MAX_MS || "200");
      const delayMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const costUsd = parseFloat(env.MOCK_COST_USD || "0.01");
    const sessionId = `mock-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const output = CANNED_OUTPUTS[Math.floor(Math.random() * CANNED_OUTPUTS.length)];

    const result = {
      output,
      session_id: sessionId,
      success: true,
      turns: 1,
      tool_calls: 0,
      cost_usd: costUsd,
      latency_ms: zeroLatency ? 1 : parseInt(env.MOCK_LATENCY_MIN_MS || "50"),
      model: "load-test-mock",
      total_tokens: 150,
      input: String(body.input || ""),
      agent_name: String(body.agent_name || ""),
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};
