// AgentOS Customer Worker Template
// Deployed per-agent into the dispatch namespace.
// Stateless proxy: forwards all requests to the backend runtime proxy.
// Only env vars differ per agent — code is identical for everyone.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        agent: env.AGENT_NAME || "",
        org: env.ORG_ID || "",
        project: env.PROJECT_ID || "",
        type: "dispatch",
      });
    }

    const backendUrl = env.BACKEND_INGEST_URL || "";
    const token = env.BACKEND_INGEST_TOKEN || "";
    if (!backendUrl || !token) {
      return Response.json({ error: "worker not configured" }, { status: 503 });
    }

    // Forward to backend runtime proxy — full agent harness runs there
    const body = await request.json().catch(() => ({}));
    const resp = await fetch(`${backendUrl}/api/v1/runtime-proxy/agent/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "X-Edge-Token": token,
      },
      body: JSON.stringify({
        ...body,
        agent_name: env.AGENT_NAME || body.agent_name || "",
        org_id: env.ORG_ID || body.org_id || "",
        project_id: env.PROJECT_ID || body.project_id || "",
        channel: "dispatch_worker",
        channel_user_id: body.channel_user_id || "",
      }),
    });

    return new Response(resp.body, {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  },
};
