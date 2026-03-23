import { useMemo, useState } from "react";
import {
  Plus,
  Plug,
  Server,
  Wrench,
  Search,
  Trash2,
  Eye,
  Link2,
  RefreshCw,
  Shield,
  Play,
  ExternalLink,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { FormField } from "../../components/common/FormField";
import { SlidePanel } from "../../components/common/SlidePanel";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { ActionMenu, type ActionMenuItem } from "../../components/common/ActionMenu";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { Tabs } from "../../components/common/Tabs";
import { useToast } from "../../components/common/ToastProvider";
import { apiRequest, useApiQuery } from "../../lib/api";

type ConnectorTool = { name: string; app?: string; description?: string };
type McpServer = {
  server_id?: string;
  name?: string;
  url?: string;
  transport?: string;
  status?: string;
  tool_count?: number;
};

export const IntegrationsPage = () => {
  const { showToast } = useToast();

  /* ── Queries ──────────────────────────────────────────────── */
  const toolsQuery = useApiQuery<{ tools: ConnectorTool[]; total?: number }>(
    "/api/v1/integrations/tools",
  );
  const mcpQuery = useApiQuery<{ servers: McpServer[] }>(
    "/api/v1/integrations/mcp/servers",
  );
  const tools = useMemo(
    () => toolsQuery.data?.tools ?? [],
    [toolsQuery.data],
  );
  const mcpServers = useMemo(
    () => mcpQuery.data?.servers ?? [],
    [mcpQuery.data],
  );

  /* ── Search ───────────────────────────────────────────────── */
  const [toolSearch, setToolSearch] = useState("");
  const [mcpSearch, setMcpSearch] = useState("");
  const filteredTools = toolSearch
    ? tools.filter(
        (t) =>
          t.name.toLowerCase().includes(toolSearch.toLowerCase()) ||
          (t.app ?? "").toLowerCase().includes(toolSearch.toLowerCase()),
      )
    : tools;
  const filteredMcp = mcpSearch
    ? mcpServers.filter(
        (s) =>
          (s.name ?? "").toLowerCase().includes(mcpSearch.toLowerCase()) ||
          (s.url ?? "").toLowerCase().includes(mcpSearch.toLowerCase()),
      )
    : mcpServers;

  /* ── OAuth connect ────────────────────────────────────────── */
  const [connectPanelOpen, setConnectPanelOpen] = useState(false);
  const [connectForm, setConnectForm] = useState({ app: "", redirect_url: "" });
  const [authUrl, setAuthUrl] = useState("");

  /* ── MCP register ─────────────────────────────────────────── */
  const [mcpPanelOpen, setMcpPanelOpen] = useState(false);
  const [mcpForm, setMcpForm] = useState({
    name: "",
    url: "",
    transport: "http",
  });
  const [mcpFormErrors, setMcpFormErrors] = useState<Record<string, string>>({});

  /* ── Tool call tester ─────────────────────────────────────── */
  const [testPanelOpen, setTestPanelOpen] = useState(false);
  const [testForm, setTestForm] = useState({
    tool: "",
    app: "",
    args: "{}",
  });
  const [testResult, setTestResult] = useState("");

  /* ── Detail drawer ────────────────────────────────────────── */
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<unknown>(null);

  /* ── Confirm dialog ───────────────────────────────────────── */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    desc: string;
    action: () => Promise<void>;
  } | null>(null);

  /* ── OAuth connect ────────────────────────────────────────── */
  const handleConnect = async () => {
    if (!connectForm.app.trim()) return;
    try {
      const result = await apiRequest<{ auth_url?: string }>(
        "/api/v1/integrations/connect",
        "POST",
        connectForm,
      );
      if (result.auth_url) {
        setAuthUrl(result.auth_url);
        showToast("OAuth URL generated", "success");
      } else {
        showToast("Connected", "success");
        setConnectPanelOpen(false);
      }
    } catch {
      showToast("Connection failed", "error");
    }
  };

  /* ── MCP register ─────────────────────────────────────────── */
  const handleRegisterMcp = async () => {
    const errors: Record<string, string> = {};
    if (!mcpForm.name.trim()) errors.name = "Required";
    if (!mcpForm.url.trim()) errors.url = "Required";
    setMcpFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    try {
      await apiRequest("/api/v1/integrations/mcp/servers", "POST", mcpForm);
      showToast(`MCP server "${mcpForm.name}" registered`, "success");
      setMcpPanelOpen(false);
      setMcpForm({ name: "", url: "", transport: "http" });
      void mcpQuery.refetch();
    } catch {
      showToast("Failed to register MCP server", "error");
    }
  };

  /* ── Delete MCP ───────────────────────────────────────────── */
  const handleDeleteMcp = (server: McpServer) => {
    setConfirmAction({
      title: "Remove MCP Server",
      desc: `Remove "${server.name}"? Tools from this server will no longer be available.`,
      action: async () => {
        await apiRequest(
          `/api/v1/integrations/mcp/servers/${server.server_id}`,
          "DELETE",
        );
        showToast("MCP server removed", "success");
        void mcpQuery.refetch();
      },
    });
    setConfirmOpen(true);
  };

  /* ── Tool call ────────────────────────────────────────────── */
  const handleCallTool = async () => {
    if (!testForm.tool.trim()) return;
    setTestResult("");
    try {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(testForm.args);
      } catch {
        showToast("Invalid JSON args", "error");
        return;
      }
      const result = await apiRequest<unknown>(
        "/api/v1/integrations/tools/call",
        "POST",
        {
          tool_name: testForm.tool,
          app: testForm.app || undefined,
          arguments: parsedArgs,
        },
      );
      setTestResult(JSON.stringify(result, null, 2));
    } catch (err) {
      setTestResult(
        err instanceof Error ? err.message : "Tool call failed",
      );
    }
  };

  /* ── MCP row actions ──────────────────────────────────────── */
  const getMcpActions = (server: McpServer): ActionMenuItem[] => [
    {
      label: "View Details",
      icon: <Eye size={12} />,
      onClick: () => {
        setDetailItem(server);
        setDetailOpen(true);
      },
    },
    {
      label: "Sync Tools",
      icon: <RefreshCw size={12} />,
      onClick: () => {
        showToast("Syncing tools...", "info");
        void mcpQuery.refetch();
      },
    },
    {
      label: "Remove",
      icon: <Trash2 size={12} />,
      onClick: () => handleDeleteMcp(server),
      danger: true,
    },
  ];

  const activeConnectors = mcpServers.filter(
    (s) => s.status === "healthy" || s.status === "active",
  ).length;

  /* ── Connectors tab ───────────────────────────────────────── */
  const connectorsTab = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            placeholder="Search tools..."
            value={toolSearch}
            onChange={(e) => setToolSearch(e.target.value)}
            className="pl-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-secondary text-xs"
            onClick={() => {
              setTestForm({ tool: "", app: "", args: "{}" });
              setTestResult("");
              setTestPanelOpen(true);
            }}
          >
            <Play size={12} />
            Test Tool
          </button>
          <button
            className="btn btn-primary text-xs"
            onClick={() => {
              setConnectForm({ app: "", redirect_url: "" });
              setAuthUrl("");
              setConnectPanelOpen(true);
            }}
          >
            <Link2 size={12} />
            Connect App
          </button>
        </div>
      </div>
      {filteredTools.length === 0 ? (
        <EmptyState
          icon={<Wrench size={40} />}
          title="No connector tools"
          description="Connect an app to browse its available tools"
        />
      ) : (
        <div className="card p-0">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>App</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {filteredTools.map((tool) => (
                  <tr key={`${tool.name}-${tool.app}`}>
                    <td>
                      <div className="flex items-center gap-2">
                        <Wrench size={12} className="text-text-muted" />
                        <span className="font-mono text-xs text-text-primary">
                          {tool.name}
                        </span>
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={tool.app ?? "unknown"} />
                    </td>
                    <td>
                      <span className="text-text-muted text-xs">
                        {(tool.description ?? "").slice(0, 80)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );

  /* ── MCP Servers tab ──────────────────────────────────────── */
  const mcpTab = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            placeholder="Search servers..."
            value={mcpSearch}
            onChange={(e) => setMcpSearch(e.target.value)}
            className="pl-8 text-xs"
          />
        </div>
        <button
          className="btn btn-primary text-xs"
          onClick={() => {
            setMcpForm({ name: "", url: "", transport: "http" });
            setMcpFormErrors({});
            setMcpPanelOpen(true);
          }}
        >
          <Plus size={12} />
          Register Server
        </button>
      </div>
      {filteredMcp.length === 0 ? (
        <EmptyState
          icon={<Server size={40} />}
          title="No MCP servers"
          description="Register an MCP server to extend agent capabilities"
        />
      ) : (
        <div className="card p-0">
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>URL</th>
                  <th>Transport</th>
                  <th>Status</th>
                  <th>Tools</th>
                  <th style={{ width: "48px" }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredMcp.map((server) => (
                  <tr key={server.server_id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <Server size={12} className="text-text-muted" />
                        <span className="text-text-primary text-sm">
                          {server.name}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="font-mono text-[10px] text-text-muted">
                        {(server.url ?? "").slice(0, 40)}
                      </span>
                    </td>
                    <td>
                      <span className="px-1.5 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded border border-border-default">
                        {server.transport ?? "http"}
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={server.status ?? "unknown"} />
                    </td>
                    <td>
                      <span className="text-text-muted text-xs font-mono">
                        {server.tool_count ?? 0}
                      </span>
                    </td>
                    <td>
                      <ActionMenu items={getMcpActions(server)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Integrations"
        subtitle="Manage connectors, MCP servers, and tool access"
        liveCount={activeConnectors}
        liveLabel="Active"
        onRefresh={() => {
          void toolsQuery.refetch();
          void mcpQuery.refetch();
        }}
      />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-green/10">
            <Plug size={14} className="text-chart-green" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {tools.length}
            </p>
            <p className="text-[10px] text-text-muted uppercase">
              Connector Tools
            </p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-purple/10">
            <Server size={14} className="text-chart-purple" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {mcpServers.length}
            </p>
            <p className="text-[10px] text-text-muted uppercase">
              MCP Servers
            </p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-accent/10">
            <Shield size={14} className="text-accent" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {activeConnectors}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Active</p>
          </div>
        </div>
      </div>

      <Tabs
        tabs={[
          {
            id: "connectors",
            label: "Connector Tools",
            count: tools.length,
            content: connectorsTab,
          },
          {
            id: "mcp",
            label: "MCP Servers",
            count: mcpServers.length,
            content: mcpTab,
          },
        ]}
      />

      {/* Connect App panel */}
      <SlidePanel
        isOpen={connectPanelOpen}
        onClose={() => setConnectPanelOpen(false)}
        title="Connect App"
        subtitle="Authenticate via OAuth to access app tools"
        footer={
          <>
            <button
              className="btn btn-secondary text-xs"
              onClick={() => setConnectPanelOpen(false)}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary text-xs"
              onClick={() => void handleConnect()}
            >
              <Link2 size={12} />
              Connect
            </button>
          </>
        }
      >
        <FormField label="App Name" required hint="e.g. github, slack, notion">
          <input
            type="text"
            value={connectForm.app}
            onChange={(e) =>
              setConnectForm({ ...connectForm, app: e.target.value })
            }
            placeholder="github"
            className="text-sm"
          />
        </FormField>
        <FormField label="Redirect URL" hint="Optional callback URL">
          <input
            type="text"
            value={connectForm.redirect_url}
            onChange={(e) =>
              setConnectForm({ ...connectForm, redirect_url: e.target.value })
            }
            placeholder="https://..."
            className="text-sm"
          />
        </FormField>
        {authUrl && (
          <div className="mt-4 p-3 bg-surface-base border border-border-default rounded-lg">
            <p className="text-xs text-text-muted mb-2">
              Complete authentication:
            </p>
            <a
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-accent hover:underline flex items-center gap-1"
            >
              <ExternalLink size={12} />
              Open OAuth URL
            </a>
          </div>
        )}
      </SlidePanel>

      {/* Register MCP panel */}
      <SlidePanel
        isOpen={mcpPanelOpen}
        onClose={() => setMcpPanelOpen(false)}
        title="Register MCP Server"
        subtitle="Add an external Model Context Protocol server"
        footer={
          <>
            <button
              className="btn btn-secondary text-xs"
              onClick={() => setMcpPanelOpen(false)}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary text-xs"
              onClick={() => void handleRegisterMcp()}
            >
              Register
            </button>
          </>
        }
      >
        <FormField label="Server Name" required error={mcpFormErrors.name}>
          <input
            type="text"
            value={mcpForm.name}
            onChange={(e) =>
              setMcpForm({ ...mcpForm, name: e.target.value })
            }
            placeholder="my-mcp-server"
            className="text-sm"
          />
        </FormField>
        <FormField label="URL" required error={mcpFormErrors.url}>
          <input
            type="text"
            value={mcpForm.url}
            onChange={(e) =>
              setMcpForm({ ...mcpForm, url: e.target.value })
            }
            placeholder="https://mcp.example.com"
            className="text-sm"
          />
        </FormField>
        <FormField label="Transport">
          <select
            value={mcpForm.transport}
            onChange={(e) =>
              setMcpForm({ ...mcpForm, transport: e.target.value })
            }
            className="text-sm"
          >
            <option value="http">HTTP</option>
            <option value="sse">SSE</option>
            <option value="stdio">Stdio</option>
          </select>
        </FormField>
      </SlidePanel>

      {/* Tool Tester panel */}
      <SlidePanel
        isOpen={testPanelOpen}
        onClose={() => setTestPanelOpen(false)}
        title="Test Tool Call"
        subtitle="Execute a connector tool with arguments"
        footer={
          <>
            <button
              className="btn btn-secondary text-xs"
              onClick={() => setTestPanelOpen(false)}
            >
              Close
            </button>
            <button
              className="btn btn-primary text-xs"
              onClick={() => void handleCallTool()}
            >
              <Play size={12} />
              Execute
            </button>
          </>
        }
      >
        <FormField label="Tool Name" required>
          <input
            type="text"
            value={testForm.tool}
            onChange={(e) =>
              setTestForm({ ...testForm, tool: e.target.value })
            }
            placeholder="search_issues"
            className="text-sm font-mono"
          />
        </FormField>
        <FormField label="App Filter">
          <input
            type="text"
            value={testForm.app}
            onChange={(e) =>
              setTestForm({ ...testForm, app: e.target.value })
            }
            placeholder="github"
            className="text-sm"
          />
        </FormField>
        <FormField label="Arguments (JSON)">
          <textarea
            value={testForm.args}
            onChange={(e) =>
              setTestForm({ ...testForm, args: e.target.value })
            }
            rows={5}
            className="text-sm font-mono"
            placeholder='{"query": "hello"}'
          />
        </FormField>
        {testResult && (
          <div className="mt-3">
            <p className="text-xs text-text-muted mb-1">Result:</p>
            <pre className="text-xs font-mono bg-surface-base border border-border-default rounded-md p-3 overflow-x-auto max-h-60">
              {testResult}
            </pre>
          </div>
        )}
      </SlidePanel>

      {/* Detail drawer */}
      <SlidePanel
        isOpen={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setDetailItem(null);
        }}
        title="Details"
      >
        <pre className="text-xs font-mono bg-surface-base border border-border-default rounded-md p-4 overflow-x-auto max-h-96">
          {JSON.stringify(detailItem, null, 2)}
        </pre>
      </SlidePanel>

      {/* Confirm dialog */}
      {confirmOpen && confirmAction && (
        <ConfirmDialog
          title={confirmAction.title}
          description={confirmAction.desc}
          confirmLabel="Remove"
          tone="danger"
          onConfirm={async () => {
            try {
              await confirmAction.action();
            } catch {
              showToast("Action failed", "error");
            }
            setConfirmOpen(false);
            setConfirmAction(null);
          }}
          onCancel={() => {
            setConfirmOpen(false);
            setConfirmAction(null);
          }}
        />
      )}
    </div>
  );
};
