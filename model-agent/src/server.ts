/**
 * Model Agent — Reference implementation for the AgentOS composable architecture.
 *
 * This worker demonstrates the full Cloudflare Agents SDK surface:
 * - Think base class (session, streaming, compaction, tools, extensions)
 * - DO Facets (per-agent isolated SQLite within a supervisor DO)
 * - Sub-agents (fan-out, fan-in, isolated databases)
 * - Dynamic Workers (runtime code loading for tenant isolation)
 * - MCP server + client
 * - @callable() with metadata
 * - scheduleEvery(), keepAliveWhile(), broadcast(), onStateChanged()
 * - WebSocket primary + SSE fallback transport
 * - Email handling with isAutoReplyEmail()
 *
 * This is the north-star pattern. All future refactoring of the deploy/
 * monolith should converge toward this structure.
 *
 * TODO: Implement once @cloudflare/think graduates from experimental.
 * See COMPOSABLE_ARCHITECTURE.md and the blueprint for full design.
 */

// Placeholder — full implementation pending Think + Facets stabilization.
export default {
  async fetch(request: Request): Promise<Response> {
    return Response.json({
      status: "ok",
      service: "model-agent",
      note: "Reference implementation — not yet wired. See COMPOSABLE_ARCHITECTURE.md.",
    });
  },
} satisfies ExportedHandler;
