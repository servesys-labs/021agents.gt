// AgentOS Customer Worker Template
// Deployed per-agent into the dispatch namespace.
// Handles API requests by proxying to the main worker's edge runtime.
// Channel integrations (Telegram, Discord) are handled by the main worker
// because dispatch workers can't call back to the main worker (CF routing).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
      return Response.json({
        status: "ok",
        agent: env.AGENT_NAME || "",
        org: env.ORG_ID || "",
        project: env.PROJECT_ID || "",
        type: "dispatch",
      });
    }

    // Main worker URL
    const workerUrl = env.WORKER_URL || "";
    const token = env.SERVICE_TOKEN || "";
    if (!workerUrl || !token) {
      return Response.json({ error: "worker not configured" }, { status: 503 });
    }

    const body = await request.json().catch(() => ({}));

    // Route by path
    let targetPath = "/api/v1/runtime-proxy/runnable/invoke";
    if (url.pathname.endsWith("/stream") || url.pathname.endsWith("/stream-events")) {
      targetPath = "/api/v1/runtime-proxy/runnable/stream-events";
    } else if (url.pathname.endsWith("/events")) {
      targetPath = "/api/v1/runtime-proxy/runnable/events";
    } else if (url.pathname.endsWith("/run-tree") || url.pathname.endsWith("/runs/tree")) {
      targetPath = "/api/v1/runtime-proxy/runnable/runs/tree";
    } else if (url.pathname.endsWith("/batch")) {
      targetPath = "/api/v1/runtime-proxy/runnable/batch";
    } else if (url.pathname.endsWith("/latency")) {
      targetPath = "/api/v1/runtime-proxy/runnable/latency-breakdown";
    }

    const queryString = url.search || "";

    const resp = await fetch(`${workerUrl}${targetPath}${queryString}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...body,
        agent_name: env.AGENT_NAME || body.agent_name || "",
        org_id: env.ORG_ID || body.org_id || "",
        project_id: env.PROJECT_ID || body.project_id || "",
        channel: body.channel || "dispatch_worker",
        channel_user_id: body.channel_user_id || "",
      }),
    });

    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    });
  },
};
