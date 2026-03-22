import { useMemo, useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { useToast } from "../../components/common/ToastProvider";
import { apiRequest, useApiQuery } from "../../lib/api";
import { isRequired, isValidUrl } from "../../lib/validation";

type ProviderResponse = {
  active?: string;
  providers?: Array<{ name: string; apps: string; status: string }>;
};

type ConnectorToolsResponse = {
  total?: number;
  tools?: Array<{ name?: string; description?: string; app?: string; provider?: string }>;
};

type McpServersResponse = {
  servers?: Array<{ server_id?: string; name?: string; url?: string; transport?: string; status?: string }>;
};

type Webhook = {
  webhook_id: string;
  url: string;
  is_active?: boolean;
};

export const IntegrationsPage = () => {
  const { showToast } = useToast();
  const [appName, setAppName] = useState("slack");
  const [authUrl, setAuthUrl] = useState<string>("");
  const [actionMessage, setActionMessage] = useState<string>("");
  const [toolName, setToolName] = useState("");
  const [toolArgs, setToolArgs] = useState("{}");
  const [toolResult, setToolResult] = useState<string>("");
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpTransport, setMcpTransport] = useState("http");

  const providersQuery = useApiQuery<ProviderResponse>("/api/v1/connectors/providers");
  const toolsQuery = useApiQuery<ConnectorToolsResponse>(`/api/v1/connectors/tools?app=${encodeURIComponent(appName)}`);
  const mcpQuery = useApiQuery<McpServersResponse>("/api/v1/mcp/servers");
  const webhooksQuery = useApiQuery<Webhook[]>("/api/v1/webhooks");

  const providers = useMemo(() => providersQuery.data?.providers ?? [], [providersQuery.data]);
  const tools = useMemo(() => toolsQuery.data?.tools ?? [], [toolsQuery.data]);
  const mcpServers = useMemo(() => mcpQuery.data?.servers ?? [], [mcpQuery.data]);
  const webhooks = useMemo(() => webhooksQuery.data ?? [], [webhooksQuery.data]);

  const loadAuthUrl = async () => {
    if (!isRequired(appName)) {
      showToast("App name is required.", "error");
      return;
    }
    setActionMessage("");
    try {
      const result = await apiRequest<{ auth_url?: string }>(`/api/v1/connectors/auth/${encodeURIComponent(appName)}`);
      setAuthUrl(result.auth_url ?? "");
      setActionMessage(result.auth_url ? "Connector auth URL loaded." : "No auth URL returned.");
      showToast(result.auth_url ? "Connector auth URL loaded." : "No auth URL returned.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load auth URL";
      setActionMessage(message);
      showToast(message, "error");
      setAuthUrl("");
    }
  };

  const registerMcp = async () => {
    if (!isValidUrl(mcpUrl)) {
      const message = "MCP URL must be a valid http/https URL.";
      setActionMessage(message);
      showToast(message, "error");
      return;
    }
    setActionMessage("");
    try {
      const payload = await apiRequest<{ server_id: string; status: string }>("/api/v1/mcp/servers", "POST", {
        name: mcpName || "mcp-server",
        url: mcpUrl,
        transport: mcpTransport,
      });
      setActionMessage(`Registered MCP server ${payload.server_id}`);
      showToast(`Registered MCP server ${payload.server_id}`, "success");
      await mcpQuery.refetch();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to register MCP server";
      setActionMessage(message);
      showToast(message, "error");
    }
  };

  const callConnectorTool = async () => {
    if (!isRequired(toolName)) {
      const message = "Tool name is required.";
      setActionMessage(message);
      showToast(message, "error");
      return;
    }
    setActionMessage("");
    setToolResult("");
    try {
      const parsedArgs = JSON.parse(toolArgs || "{}");
      const payload = await apiRequest<Record<string, unknown>>("/api/v1/connectors/tools/call", "POST", {
        tool_name: toolName,
        arguments: parsedArgs,
        app: appName,
      });
      setToolResult(JSON.stringify(payload, null, 2));
      showToast("Connector tool call completed.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to call connector tool";
      setActionMessage(message);
      showToast(message, "error");
    }
  };

  return (
    <div>
      <PageHeader title="Integrations" subtitle="Connectors, MCP servers, and webhook delivery surface" />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card">
          <p className="font-semibold text-white mb-3">Connector Providers</p>
          <QueryState
            loading={providersQuery.loading}
            error={providersQuery.error}
            isEmpty={providers.length === 0}
            emptyMessage="No providers available."
          >
            <table className="os-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Apps</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((provider) => (
                  <tr key={provider.name}>
                    <td><span className="text-gray-400">{provider.name}</span></td>
                    <td><span className="text-gray-400">{provider.apps}</span></td>
                    <td>
                      <span className="badge">
                        {provider.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>

        <div className="card">
          <p className="font-semibold text-white mb-3">Connect an App</p>
          <div className="space-y-3">
            <input className="input-field" value={appName} onChange={(event) => setAppName(event.target.value)} placeholder="slack, notion, github..." />
            <button className="btn-primary" onClick={() => void loadAuthUrl()}>Get Auth URL</button>
            {actionMessage ? <span className="text-gray-400">{actionMessage}</span> : null}
            {authUrl ? (
              <a href={authUrl} target="_blank" rel="noreferrer" className="text-sm text-[#ff8c00] hover:text-[#ffa940] hover:underline break-all">
                {authUrl}
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-6 mt-6 lg:grid-cols-2">
        <div className="card">
          <p className="font-semibold text-white mb-3">Connector Tools ({toolsQuery.data?.total ?? tools.length})</p>
          <QueryState
            loading={toolsQuery.loading}
            error={toolsQuery.error}
            isEmpty={tools.length === 0}
            emptyMessage="No tools for selected app."
          >
            <table className="os-table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>App</th>
                </tr>
              </thead>
              <tbody>
                {tools.map((tool) => (
                  <tr key={`${tool.name}-${tool.app}`}>
                    <td>
                      <span className="text-gray-400">{tool.name}</span>
                      <span className="text-xs text-gray-500">{tool.description ?? ""}</span>
                    </td>
                    <td><span className="text-gray-400">{tool.app ?? "n/a"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>

        <div className="card">
          <p className="font-semibold text-white mb-3">MCP Servers</p>
          <div className="mb-3 grid gap-2 md:grid-cols-3">
            <input className="input-field" value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="Server name" />
            <input className="input-field" value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} placeholder="https://mcp.example.com" />
            <input className="input-field" value={mcpTransport} onChange={(event) => setMcpTransport(event.target.value)} placeholder="http|sse|stdio" />
          </div>
          <button className="btn-primary text-xs mb-3" onClick={() => void registerMcp()}>Register MCP Server</button>
          <QueryState
            loading={mcpQuery.loading}
            error={mcpQuery.error}
            isEmpty={mcpServers.length === 0}
            emptyMessage="No MCP servers registered."
          >
            <table className="os-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Transport</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {mcpServers.map((server) => (
                  <tr key={server.server_id}>
                    <td><span className="text-gray-400">{server.name}</span></td>
                    <td><span className="text-gray-400">{server.transport ?? "unknown"}</span></td>
                    <td><span className="badge">{server.status ?? "unknown"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>
      </div>

      <div className="card mt-6">
        <p className="font-semibold text-white mb-3">Connector Tool Call</p>
        <div className="grid gap-2 md:grid-cols-3">
          <input className="input-field" value={toolName} onChange={(event) => setToolName(event.target.value)} placeholder="tool name" />
          <input className="input-field" value={appName} onChange={(event) => setAppName(event.target.value)} placeholder="app filter" />
          <input className="input-field" value={toolArgs} onChange={(event) => setToolArgs(event.target.value)} placeholder='{"query":"hello"}' />
        </div>
        <button className="btn-primary text-xs mt-3" onClick={() => void callConnectorTool()}>Call Tool</button>
        {toolResult ? (
          <pre className="mt-3 max-h-72 overflow-auto rounded bg-[#111] border border-[#2a2a2a] p-3 text-xs">{toolResult}</pre>
        ) : null}
      </div>

      <div className="card mt-6">
        <p className="font-semibold text-white mb-3">Webhooks</p>
        <QueryState
          loading={webhooksQuery.loading}
          error={webhooksQuery.error}
          isEmpty={webhooks.length === 0}
          emptyMessage="No webhooks configured."
        >
          <table className="os-table">
            <thead>
              <tr>
                <th>Webhook ID</th>
                <th>URL</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {webhooks.map((webhook) => (
                <tr key={webhook.webhook_id}>
                  <td><span className="font-mono text-xs text-gray-300">{webhook.webhook_id}</span></td>
                  <td><span className="text-gray-400">{webhook.url}</span></td>
                  <td><span className="badge">{webhook.is_active ? "active" : "disabled"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </QueryState>
      </div>
    </div>
  );
};
