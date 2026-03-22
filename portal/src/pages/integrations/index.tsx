import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, TextInput } from "@tremor/react";
import { useMemo, useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { apiRequest, useApiQuery } from "../../lib/api";

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
    setActionMessage("");
    try {
      const result = await apiRequest<{ auth_url?: string }>(`/api/v1/connectors/auth/${encodeURIComponent(appName)}`);
      setAuthUrl(result.auth_url ?? "");
      setActionMessage(result.auth_url ? "Connector auth URL loaded." : "No auth URL returned.");
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Failed to load auth URL");
      setAuthUrl("");
    }
  };

  const registerMcp = async () => {
    setActionMessage("");
    try {
      const payload = await apiRequest<{ server_id: string; status: string }>("/api/v1/mcp/servers", "POST", {
        name: mcpName || "mcp-server",
        url: mcpUrl,
        transport: mcpTransport,
      });
      setActionMessage(`Registered MCP server ${payload.server_id}`);
      await mcpQuery.refetch();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Failed to register MCP server");
    }
  };

  const callConnectorTool = async () => {
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
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Failed to call connector tool");
    }
  };

  return (
    <div>
      <PageHeader title="Integrations" subtitle="Connectors, MCP servers, and webhook delivery surface" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <Text className="font-semibold mb-3">Connector Providers</Text>
          <QueryState
            loading={providersQuery.loading}
            error={providersQuery.error}
            isEmpty={providers.length === 0}
            emptyMessage="No providers available."
          >
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Apps</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {providers.map((provider) => (
                  <TableRow key={provider.name}>
                    <TableCell><Text>{provider.name}</Text></TableCell>
                    <TableCell><Text>{provider.apps}</Text></TableCell>
                    <TableCell>
                      <Badge color={provider.name === providersQuery.data?.active ? "green" : "gray"}>
                        {provider.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </QueryState>
        </Card>

        <Card>
          <Text className="font-semibold mb-3">Connect an App</Text>
          <div className="space-y-3">
            <TextInput value={appName} onChange={(event) => setAppName(event.target.value)} placeholder="slack, notion, github..." />
            <Button onClick={() => void loadAuthUrl()}>Get Auth URL</Button>
            {actionMessage ? <Text>{actionMessage}</Text> : null}
            {authUrl ? (
              <a href={authUrl} target="_blank" rel="noreferrer" className="text-sm text-blue-600 hover:underline break-all">
                {authUrl}
              </a>
            ) : null}
          </div>
        </Card>
      </div>

      <div className="grid gap-6 mt-6 lg:grid-cols-2">
        <Card>
          <Text className="font-semibold mb-3">Connector Tools ({toolsQuery.data?.total ?? tools.length})</Text>
          <QueryState
            loading={toolsQuery.loading}
            error={toolsQuery.error}
            isEmpty={tools.length === 0}
            emptyMessage="No tools for selected app."
          >
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Tool</TableHeaderCell>
                  <TableHeaderCell>App</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {tools.map((tool) => (
                  <TableRow key={`${tool.name}-${tool.app}`}>
                    <TableCell>
                      <Text>{tool.name}</Text>
                      <Text className="text-xs text-gray-500">{tool.description ?? ""}</Text>
                    </TableCell>
                    <TableCell><Text>{tool.app ?? "n/a"}</Text></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </QueryState>
        </Card>

        <Card>
          <Text className="font-semibold mb-3">MCP Servers</Text>
          <div className="mb-3 grid gap-2 md:grid-cols-3">
            <TextInput value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="Server name" />
            <TextInput value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} placeholder="https://mcp.example.com" />
            <TextInput value={mcpTransport} onChange={(event) => setMcpTransport(event.target.value)} placeholder="http|sse|stdio" />
          </div>
          <Button size="xs" className="mb-3" onClick={() => void registerMcp()}>Register MCP Server</Button>
          <QueryState
            loading={mcpQuery.loading}
            error={mcpQuery.error}
            isEmpty={mcpServers.length === 0}
            emptyMessage="No MCP servers registered."
          >
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Transport</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {mcpServers.map((server) => (
                  <TableRow key={server.server_id}>
                    <TableCell><Text>{server.name}</Text></TableCell>
                    <TableCell><Text>{server.transport ?? "unknown"}</Text></TableCell>
                    <TableCell><Badge>{server.status ?? "unknown"}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </QueryState>
        </Card>
      </div>

      <Card className="mt-6">
        <Text className="font-semibold mb-3">Connector Tool Call</Text>
        <div className="grid gap-2 md:grid-cols-3">
          <TextInput value={toolName} onChange={(event) => setToolName(event.target.value)} placeholder="tool name" />
          <TextInput value={appName} onChange={(event) => setAppName(event.target.value)} placeholder="app filter" />
          <TextInput value={toolArgs} onChange={(event) => setToolArgs(event.target.value)} placeholder='{"query":"hello"}' />
        </div>
        <Button size="xs" className="mt-3" onClick={() => void callConnectorTool()}>Call Tool</Button>
        {toolResult ? (
          <pre className="mt-3 max-h-72 overflow-auto rounded bg-gray-50 p-3 text-xs">{toolResult}</pre>
        ) : null}
      </Card>

      <Card className="mt-6">
        <Text className="font-semibold mb-3">Webhooks</Text>
        <QueryState
          loading={webhooksQuery.loading}
          error={webhooksQuery.error}
          isEmpty={webhooks.length === 0}
          emptyMessage="No webhooks configured."
        >
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Webhook ID</TableHeaderCell>
                <TableHeaderCell>URL</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {webhooks.map((webhook) => (
                <TableRow key={webhook.webhook_id}>
                  <TableCell><Text className="font-mono text-xs">{webhook.webhook_id}</Text></TableCell>
                  <TableCell><Text>{webhook.url}</Text></TableCell>
                  <TableCell><Badge color={webhook.is_active ? "green" : "gray"}>{webhook.is_active ? "active" : "disabled"}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </QueryState>
      </Card>
    </div>
  );
};
