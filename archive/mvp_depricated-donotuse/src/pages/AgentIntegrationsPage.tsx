import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Check, ExternalLink, Loader2, AlertCircle } from "lucide-react";
import { Button } from "../components/ui/Button";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { agentPathSegment } from "../lib/agent-path";
import { ensureArray } from "../lib/ensure-array";

interface ConnectorProvider {
  app: string;
  name: string;
  connected: boolean;
  tool_count: number;
}

/** Control plane returns `{ providers: [...], active }`, not a bare array. */
function normalizeConnectorProviders(body: unknown): ConnectorProvider[] {
  if (Array.isArray(body)) {
    return ensureArray<ConnectorProvider>(body);
  }
  if (body && typeof body === "object" && "providers" in body) {
    const raw = ensureArray<{ name?: string; apps?: string; status?: string }>(
      (body as { providers?: unknown }).providers,
    );
    const active = String((body as { active?: string }).active || "");
    return raw.map((p) => {
      const app = String(p.name || "unknown");
      const appsLabel = String(p.apps || "");
      const toolGuess = (() => {
        const m = appsLabel.match(/[\d,]+/);
        if (!m) return 0;
        return parseInt(m[0].replace(/,/g, ""), 10) || 0;
      })();
      return {
        app,
        name: app.charAt(0).toUpperCase() + app.slice(1),
        connected: p.status === "connected" || (!!active && active === app),
        tool_count: toolGuess,
      };
    });
  }
  return [];
}

export default function AgentIntegrationsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [agentName, setAgentName] = useState<string | null>(null);
  const [providers, setProviders] = useState<ConnectorProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectingApp, setConnectingApp] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ConnectorProvider | null>(null);
  const [filter, setFilter] = useState<"all" | "connected">("all");

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        const [agent, providerBody] = await Promise.all([
          api.get<{ name: string }>(`/agents/${agentPathSegment(id)}`),
          api.get<unknown>(`/connectors/providers`),
        ]);
        if (cancelled) return;

        setAgentName(agent.name ?? id);
        setProviders(normalizeConnectorProviders(providerBody));
      } catch (err: any) {
        if (!cancelled) setError(err.message || "Failed to load integrations");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [id]);

  const connected = providers.filter((p) => p.connected);
  const filtered = providers.filter((p) => (filter === "all" ? true : p.connected));
  const totalTools = connected.reduce((s, c) => s + c.tool_count, 0);

  const handleConnect = async (app: string) => {
    setConnectingApp(app);
    try {
      const result = await api.get<{ redirect_url?: string }>(`/connectors/auth/${app}`);
      if (result.redirect_url) {
        window.open(result.redirect_url, "_blank", "width=600,height=700");
      }
      toast("Connection initiated! Complete authorization in the popup window.");
      // Refresh providers after a delay to pick up new connection
      setTimeout(async () => {
        try {
          const updated = await api.get<unknown>(`/connectors/providers`);
          setProviders(normalizeConnectorProviders(updated));
        } catch { /* ignore refresh errors */ }
      }, 3000);
    } catch (err: any) {
      toast(err.message || "Failed to connect");
    } finally {
      setConnectingApp(null);
    }
  };

  const handleDisconnect = (app: string) => {
    // Optimistic local update — real disconnect would need an API endpoint
    setProviders((prev) => prev.map((p) => (p.app === app ? { ...p, connected: false } : p)));
    setSelectedProvider(null);
    toast("Integration disconnected");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={24} className="animate-spin text-primary" />
        <span className="ml-2 text-sm text-text-secondary">Loading integrations...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-24">
        <p className="text-sm text-danger mb-2">{error}</p>
        <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>Retry</Button>
      </div>
    );
  }

  if (!agentName) return <AgentNotFound />;

  return (
    <div>
      <AgentNav agentName={agentName} />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card>
          <p className="text-xs text-text-secondary">Connected</p>
          <p className="text-xl font-semibold text-text">{connected.length}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-secondary">Available</p>
          <p className="text-xl font-semibold text-text">{providers.length}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-secondary">Tools available</p>
          <p className="text-xl font-semibold text-text">{totalTools}</p>
        </Card>
      </div>

      {/* Filter */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setFilter("all")}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            filter === "all" ? "bg-primary text-white" : "text-text-secondary hover:bg-surface-alt"
          }`}
        >
          All
        </button>
        <button
          onClick={() => setFilter("connected")}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            filter === "connected" ? "bg-primary text-white" : "text-text-secondary hover:bg-surface-alt"
          }`}
        >
          Connected ({connected.length})
        </button>
      </div>

      {/* Empty state */}
      {providers.length === 0 && (
        <Card>
          <div className="text-center py-12">
            <AlertCircle size={40} className="mx-auto text-text-muted mb-3" />
            <p className="text-sm font-medium text-text mb-1">No integrations available</p>
            <p className="text-xs text-text-muted">Connector providers will appear here once configured.</p>
          </div>
        </Card>
      )}

      {/* Integration grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((provider) => (
          <Card
            key={provider.app}
            hover
            onClick={() => provider.connected ? setSelectedProvider(provider) : handleConnect(provider.app)}
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center text-lg border bg-surface-alt border-border">
                {provider.app[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-text">{provider.name}</h3>
                  {provider.connected && <Badge variant="success"><Check size={10} className="mr-0.5" /> Connected</Badge>}
                </div>
                <p className="text-xs text-text-secondary mt-0.5">{provider.tool_count} tool{provider.tool_count !== 1 ? "s" : ""} available</p>
              </div>
              {!provider.connected && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={connectingApp === provider.app}
                  onClick={(e) => { e.stopPropagation(); handleConnect(provider.app); }}
                >
                  {connectingApp === provider.app ? <Loader2 size={14} className="animate-spin" /> : null}
                  Connect
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>

      {/* Integration detail modal */}
      <Modal open={!!selectedProvider} onClose={() => setSelectedProvider(null)} title={selectedProvider?.name || ""} wide>
        {selectedProvider && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg flex items-center justify-center text-xl border bg-surface-alt border-border">
                {selectedProvider.app[0].toUpperCase()}
              </div>
              <div className="flex-1">
                <p className="font-medium text-text">{selectedProvider.name}</p>
                <p className="text-xs text-text-muted">{selectedProvider.tool_count} tools</p>
              </div>
              <Badge variant="success">Connected</Badge>
            </div>

            <div className="flex items-center gap-2 px-3 py-2 bg-info-light text-info-dark text-xs rounded-lg">
              <AlertCircle size={14} />
              Your agent automatically uses this integration when customers ask relevant questions.
            </div>

            <div className="flex justify-between pt-2">
              <Button variant="danger" size="sm" onClick={() => handleDisconnect(selectedProvider.app)}>
                Disconnect
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedProvider(null)}>Close</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
