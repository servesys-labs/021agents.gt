import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Code,
  Copy,
  Globe,
  Loader2,
  MessageCircle,
  Rocket,
  Zap,
} from "lucide-react";
import { apiPost } from "../../lib/api";

/* ── Component ──────────────────────────────────────────────────── */

export function DeployPage() {
  const { name: agentName } = useParams<{ name: string }>();
  const navigate = useNavigate();

  const [botToken, setBotToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [telegramConnected, setTelegramConnected] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  /* URLs */
  const prodWorkerBase = "https://agentos.servesys.workers.dev";
  const restUrl = `${prodWorkerBase}/api/v1/agents/${agentName}/run`;
  const wsUrl = `wss://agentos.servesys.workers.dev/agents/agentos-agent/${agentName}`;
  const embedScript = `<script src="${prodWorkerBase}/embed.js" data-agent="${agentName}"></script>`;

  /* ── Copy to clipboard ─────────────────────────────────────────── */

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* fallback */
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  /* ── Connect Telegram ──────────────────────────────────────────── */

  const handleConnectTelegram = async () => {
    if (!botToken.trim() || !agentName) return;
    setConnecting(true);
    setError(null);
    try {
      await apiPost("/api/v1/chat/telegram/connect", {
        agent_name: agentName,
        bot_token: botToken.trim(),
      });
      setTelegramConnected(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect Telegram");
    } finally {
      setConnecting(false);
    }
  };

  /* ── Deploy to production ──────────────────────────────────────── */

  const handleDeploy = async () => {
    if (!agentName) return;
    setDeploying(true);
    setError(null);
    try {
      await apiPost(`/api/v1/deploy/${agentName}`);
      await apiPost(`/api/v1/releases/${agentName}/promote`, {
        from_channel: "draft",
        to_channel: "production",
      });
      navigate(`/agents/${agentName}/success`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deploy failed");
    } finally {
      setDeploying(false);
    }
  };

  /* ── Render ────────────────────────────────────────────────────── */

  return (
    <div className="max-w-3xl mx-auto">
      {/* Back */}
      <button
        onClick={() => navigate(agentName ? `/agents/${agentName}` : "/agents")}
        className="flex items-center gap-[var(--space-2)] text-[var(--text-sm)] text-text-muted hover:text-text-primary transition-colors mb-[var(--space-6)] min-h-[var(--touch-target-min)]"
      >
        <ArrowLeft size={16} />
        Back to {agentName}
      </button>

      {/* Title */}
      <div className="mb-[var(--space-8)]">
        <h1 className="text-[var(--text-xl)] font-bold text-text-primary">
          Deploy: {agentName}
        </h1>
        <p className="text-[var(--text-sm)] text-text-muted mt-[var(--space-2)]">
          Configure channels and deploy your agent to production
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-[var(--space-4)] p-[var(--space-3)] rounded-lg bg-status-error/10 border border-status-error/20 text-[var(--text-sm)] text-status-error">
          {error}
        </div>
      )}

      <div className="space-y-[var(--space-6)]">
        {/* ── API Section ──────────────────────────────────────────── */}
        <div className="card">
          <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-4)]">
            <div className="p-2 rounded-lg bg-accent-muted">
              <Globe size={18} className="text-accent" />
            </div>
            <div>
              <h2 className="text-[var(--text-md)] font-semibold text-text-primary">API</h2>
              <p className="text-[var(--text-xs)] text-text-muted">Always available</p>
            </div>
            <span className="ml-auto badge-live">LIVE</span>
          </div>

          {/* REST URL */}
          <div className="mb-[var(--space-3)]">
            <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              REST Endpoint
            </label>
            <div className="flex items-center gap-[var(--space-2)]">
              <code className="flex-1 text-[var(--text-xs)] font-mono text-text-secondary bg-surface-base border border-border-default rounded-md px-[var(--space-3)] py-[var(--space-2)] overflow-x-auto">
                {restUrl}
              </code>
              <button
                onClick={() => void copyToClipboard(restUrl, "rest")}
                className="btn btn-ghost min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                title="Copy"
              >
                {copied === "rest" ? <Check size={16} className="text-status-live" /> : <Copy size={16} />}
              </button>
            </div>
          </div>

          {/* WebSocket URL */}
          <div>
            <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              WebSocket Endpoint
            </label>
            <div className="flex items-center gap-[var(--space-2)]">
              <code className="flex-1 text-[var(--text-xs)] font-mono text-text-secondary bg-surface-base border border-border-default rounded-md px-[var(--space-3)] py-[var(--space-2)] overflow-x-auto">
                {wsUrl}
              </code>
              <button
                onClick={() => void copyToClipboard(wsUrl, "ws")}
                className="btn btn-ghost min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                title="Copy"
              >
                {copied === "ws" ? <Check size={16} className="text-status-live" /> : <Copy size={16} />}
              </button>
            </div>
          </div>
        </div>

        {/* ── Telegram Section ─────────────────────────────────────── */}
        <div className="card">
          <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-4)]">
            <div className="p-2 rounded-lg bg-status-info/10">
              <MessageCircle size={18} className="text-status-info" />
            </div>
            <div>
              <h2 className="text-[var(--text-md)] font-semibold text-text-primary">Telegram</h2>
              <p className="text-[var(--text-xs)] text-text-muted">Connect a Telegram bot</p>
            </div>
            {telegramConnected && <span className="ml-auto badge-live">CONNECTED</span>}
          </div>

          {telegramConnected ? (
            <div className="flex items-center gap-[var(--space-2)] p-[var(--space-3)] rounded-lg bg-status-live/10 border border-status-live/20">
              <Check size={16} className="text-status-live" />
              <span className="text-[var(--text-sm)] text-status-live">
                Telegram bot connected successfully
              </span>
            </div>
          ) : (
            <div className="flex items-end gap-[var(--space-3)]">
              <div className="flex-1">
                <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                  Bot Token
                </label>
                <input
                  type="text"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
                  className="text-[var(--text-sm)] font-mono"
                />
              </div>
              <button
                onClick={() => void handleConnectTelegram()}
                disabled={!botToken.trim() || connecting}
                className="btn btn-primary min-h-[var(--touch-target-min)]"
              >
                {connecting ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
                {connecting ? "Connecting..." : "Connect"}
              </button>
            </div>
          )}
        </div>

        {/* ── Embed Widget Section ─────────────────────────────────── */}
        <div className="card">
          <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-4)]">
            <div className="p-2 rounded-lg bg-chart-purple/10">
              <Code size={18} className="text-chart-purple" />
            </div>
            <div>
              <h2 className="text-[var(--text-md)] font-semibold text-text-primary">Embed Widget</h2>
              <p className="text-[var(--text-xs)] text-text-muted">Add to any website</p>
            </div>
          </div>

          <div>
            <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              Script Tag
            </label>
            <div className="flex items-center gap-[var(--space-2)]">
              <code className="flex-1 text-[var(--text-xs)] font-mono text-text-secondary bg-surface-base border border-border-default rounded-md px-[var(--space-3)] py-[var(--space-2)] overflow-x-auto">
                {embedScript}
              </code>
              <button
                onClick={() => void copyToClipboard(embedScript, "embed")}
                className="btn btn-ghost min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]"
                title="Copy"
              >
                {copied === "embed" ? <Check size={16} className="text-status-live" /> : <Copy size={16} />}
              </button>
            </div>
          </div>
        </div>

        {/* ── Deploy Button ────────────────────────────────────────── */}
        <div className="flex justify-end pt-[var(--space-4)]">
          <button
            onClick={() => void handleDeploy()}
            disabled={deploying}
            className="btn btn-primary min-h-[var(--touch-target-min)] px-[var(--space-8)] text-[var(--text-md)] bg-status-live hover:bg-status-live/90"
          >
            {deploying ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Rocket size={18} />
            )}
            {deploying ? "Deploying..." : "Deploy to Production"}
          </button>
        </div>
      </div>
    </div>
  );
}

export { DeployPage as default };
