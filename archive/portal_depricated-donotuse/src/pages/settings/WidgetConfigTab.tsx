import { useMemo, useState } from "react";
import {
  Copy,
  Check,
  RefreshCw,
  MessageSquare,
  Eye,
  Code,
  ChevronDown,
} from "lucide-react";

import { useToast } from "../../components/common/ToastProvider";
import { useApiQuery } from "../../lib/api";

/* ══════════════════════════════════════════════════════════════════
   Types
   ══════════════════════════════════════════════════════════════════ */

type Agent = { name: string };

type ApiKeyItem = {
  key_id: string;
  name: string;
  prefix?: string;
  key_prefix?: string;
};

type OrgSettings = {
  custom_domain?: string;
  org_id?: string;
  name?: string;
};

/* ══════════════════════════════════════════════════════════════════
   Constants
   ══════════════════════════════════════════════════════════════════ */

const LOCALES = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
  { value: "pt", label: "Portuguese" },
  { value: "ar", label: "Arabic" },
] as const;

const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 600;
const DEFAULT_PRIMARY_COLOR = "#6366f1";

/* ══════════════════════════════════════════════════════════════════
   WidgetConfigTab
   ══════════════════════════════════════════════════════════════════ */

export function WidgetConfigTab() {
  const { showToast } = useToast();

  /* ── Data queries ────────────────────────────────────────────── */
  const agentsQuery = useApiQuery<{ agents: Agent[] } | Agent[]>("/api/v1/agents", true);
  const keysQuery = useApiQuery<{ keys: ApiKeyItem[] } | ApiKeyItem[]>("/api/v1/api-keys", true);
  const orgQuery = useApiQuery<OrgSettings>("/api/v1/org/settings", true);

  const agents = useMemo<Agent[]>(() => {
    const raw = agentsQuery.data;
    return Array.isArray(raw) ? raw : (raw as { agents: Agent[] } | null)?.agents ?? [];
  }, [agentsQuery.data]);

  const apiKeys = useMemo<ApiKeyItem[]>(() => {
    const raw = keysQuery.data;
    return Array.isArray(raw) ? raw : (raw as { keys: ApiKeyItem[] } | null)?.keys ?? [];
  }, [keysQuery.data]);

  const customDomain = orgQuery.data?.custom_domain ?? "";

  /* ── Config state ────────────────────────────────────────────── */
  const [selectedAgent, setSelectedAgent] = useState("");
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [position, setPosition] = useState<"bottom-right" | "bottom-left">("bottom-right");
  const [title, setTitle] = useState("Support");
  const [greeting, setGreeting] = useState("Hi! How can I help?");
  const [primaryColor, setPrimaryColor] = useState(DEFAULT_PRIMARY_COLOR);
  const [logoUrl, setLogoUrl] = useState("");
  const [suggestedReplies, setSuggestedReplies] = useState("");
  const [locale, setLocale] = useState("en");
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [hidePoweredBy, setHidePoweredBy] = useState(false);
  const [copied, setCopied] = useState(false);

  /* ── Derived ─────────────────────────────────────────────────── */
  const selectedKey = apiKeys.find((k) => k.key_id === selectedKeyId);
  const keyPrefix = selectedKey ? (selectedKey.prefix ?? selectedKey.key_prefix ?? "ak_...") : "ak_...";

  const widgetHost = customDomain
    ? `https://${customDomain}`
    : "https://widget.agentos.dev";

  const suggestedRepliesArray = suggestedReplies
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  /* ── Build snippet ───────────────────────────────────────────── */
  const snippet = useMemo(() => {
    const attrs: string[] = [];

    attrs.push(`src="${widgetHost}/widget.js"`);
    if (selectedAgent) attrs.push(`data-agent="${selectedAgent}"`);
    if (selectedKey) attrs.push(`data-api-key="${keyPrefix}..."`);
    if (theme !== "light") attrs.push(`data-theme="${theme}"`);
    if (position !== "bottom-right") attrs.push(`data-position="${position}"`);
    if (title && title !== "Support") attrs.push(`data-title="${title}"`);
    if (greeting) attrs.push(`data-greeting="${greeting}"`);
    if (primaryColor !== DEFAULT_PRIMARY_COLOR) attrs.push(`data-primary-color="${primaryColor}"`);
    if (logoUrl) attrs.push(`data-logo="${logoUrl}"`);
    if (locale !== "en") attrs.push(`data-locale="${locale}"`);
    if (width !== DEFAULT_WIDTH) attrs.push(`data-width="${width}"`);
    if (height !== DEFAULT_HEIGHT) attrs.push(`data-height="${height}"`);
    if (suggestedRepliesArray.length > 0) {
      attrs.push(`data-suggested-replies='${JSON.stringify(suggestedRepliesArray)}'`);
    }
    if (hidePoweredBy) attrs.push(`data-hide-branding="true"`);

    const indent = "\n        ";
    return `<script ${attrs.join(indent)}>\n</script>`;
  }, [
    widgetHost, selectedAgent, selectedKey, keyPrefix, theme, position,
    title, greeting, primaryColor, logoUrl, locale, width, height,
    suggestedRepliesArray, hidePoweredBy,
  ]);

  const copySnippet = () => {
    void navigator.clipboard.writeText(snippet);
    setCopied(true);
    showToast("Copied to clipboard", "success");
    setTimeout(() => setCopied(false), 2000);
  };

  /* ── Loading state ───────────────────────────────────────────── */
  const isLoading = agentsQuery.loading || keysQuery.loading;

  if (isLoading) {
    return (
      <div className="card flex items-center justify-center py-12">
        <RefreshCw size={16} className="animate-spin text-accent mr-2" />
        <span className="text-sm text-text-muted">Loading widget config...</span>
      </div>
    );
  }

  /* ── Render ──────────────────────────────────────────────────── */
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">Widget Configuration</h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Left: Configuration Form ─────────────────────────── */}
        <div className="space-y-4">
          <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Settings</h3>

          {/* Agent selector */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
              Agent
            </label>
            <div className="relative">
              <select
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                className="text-sm appearance-none pr-8"
              >
                <option value="">Select an agent...</option>
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            </div>
          </div>

          {/* API Key selector */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
              API Key
            </label>
            <div className="relative">
              <select
                value={selectedKeyId}
                onChange={(e) => setSelectedKeyId(e.target.value)}
                className="text-sm appearance-none pr-8"
              >
                <option value="">Select a key...</option>
                {apiKeys.map((k) => (
                  <option key={k.key_id} value={k.key_id}>
                    {k.name} ({k.prefix ?? k.key_prefix ?? ""}...)
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            </div>
          </div>

          {/* Theme toggle */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
              Theme
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setTheme("light")}
                className={`flex-1 px-3 py-2 rounded border text-xs font-medium transition-colors ${
                  theme === "light"
                    ? "bg-accent-muted border-accent/30 text-accent"
                    : "bg-surface-base border-border-default text-text-secondary hover:border-border-strong"
                }`}
              >
                Light
              </button>
              <button
                onClick={() => setTheme("dark")}
                className={`flex-1 px-3 py-2 rounded border text-xs font-medium transition-colors ${
                  theme === "dark"
                    ? "bg-accent-muted border-accent/30 text-accent"
                    : "bg-surface-base border-border-default text-text-secondary hover:border-border-strong"
                }`}
              >
                Dark
              </button>
            </div>
          </div>

          {/* Position toggle */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
              Position
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setPosition("bottom-right")}
                className={`flex-1 px-3 py-2 rounded border text-xs font-medium transition-colors ${
                  position === "bottom-right"
                    ? "bg-accent-muted border-accent/30 text-accent"
                    : "bg-surface-base border-border-default text-text-secondary hover:border-border-strong"
                }`}
              >
                Bottom Right
              </button>
              <button
                onClick={() => setPosition("bottom-left")}
                className={`flex-1 px-3 py-2 rounded border text-xs font-medium transition-colors ${
                  position === "bottom-left"
                    ? "bg-accent-muted border-accent/30 text-accent"
                    : "bg-surface-base border-border-default text-text-secondary hover:border-border-strong"
                }`}
              >
                Bottom Left
              </button>
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Support"
              className="text-sm"
            />
          </div>

          {/* Greeting */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
              Greeting Message
            </label>
            <textarea
              value={greeting}
              onChange={(e) => setGreeting(e.target.value)}
              placeholder="Hi! How can I help?"
              rows={2}
              className="text-sm"
            />
          </div>

          {/* Primary Color */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
              Primary Color
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="w-10 h-10 rounded border border-border-default cursor-pointer p-0.5"
              />
              <input
                type="text"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                placeholder="#6366f1"
                className="text-sm font-mono flex-1"
                maxLength={7}
              />
            </div>
          </div>

          {/* Logo URL */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
              Logo URL
            </label>
            <input
              type="url"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://example.com/logo.svg"
              className="text-sm"
            />
          </div>

          {/* Suggested Replies */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
              Suggested Replies
            </label>
            <input
              type="text"
              value={suggestedReplies}
              onChange={(e) => setSuggestedReplies(e.target.value)}
              placeholder="Reset password, Billing help, Contact support"
              className="text-sm"
            />
            <p className="text-[10px] text-text-muted mt-1">
              Comma-separated list of quick reply buttons shown to users
            </p>
          </div>

          {/* Locale */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
              Locale
            </label>
            <div className="relative">
              <select
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
                className="text-sm appearance-none pr-8"
              >
                {LOCALES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label} ({l.value})
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            </div>
          </div>

          {/* Width / Height */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                Width (px)
              </label>
              <input
                type="number"
                value={width}
                onChange={(e) => setWidth(parseInt(e.target.value) || DEFAULT_WIDTH)}
                min={300}
                max={600}
                className="text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                Height (px)
              </label>
              <input
                type="number"
                value={height}
                onChange={(e) => setHeight(parseInt(e.target.value) || DEFAULT_HEIGHT)}
                min={400}
                max={900}
                className="text-sm font-mono"
              />
            </div>
          </div>

          {/* Hide powered by */}
          <div>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={hidePoweredBy}
                onChange={(e) => setHidePoweredBy(e.target.checked)}
                className="sr-only"
              />
              <span
                className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                  hidePoweredBy ? "bg-accent border-accent" : "border-border-strong bg-surface-base"
                }`}
              >
                {hidePoweredBy && <Check size={11} className="text-text-inverse" />}
              </span>
              <span className="text-xs text-text-secondary">
                Hide "Powered by AgentOS" branding
              </span>
            </label>
          </div>

          {/* Custom domain display */}
          {customDomain && (
            <div className="rounded-lg border border-accent/20 bg-accent-muted p-3">
              <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1">Custom Domain</p>
              <p className="text-xs font-mono text-accent">{customDomain}</p>
              <p className="text-[10px] text-text-muted mt-1">
                Widget will load from your custom domain
              </p>
            </div>
          )}
        </div>

        {/* ── Right: Preview + Code ────────────────────────────── */}
        <div className="space-y-4">
          {/* Live Preview */}
          <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide flex items-center gap-1.5">
            <Eye size={12} /> Preview
          </h3>

          <div className="card p-0 overflow-hidden">
            <div
              className="relative"
              style={{
                height: Math.min(height * 0.6, 400),
                backgroundColor: theme === "dark" ? "#1a1a2e" : "#f8f9fa",
              }}
            >
              {/* Mini widget preview */}
              <div
                className="absolute bottom-3 flex flex-col"
                style={{
                  width: Math.min(width * 0.6, 240),
                  ...(position === "bottom-right" ? { right: 12 } : { left: 12 }),
                }}
              >
                {/* Widget card */}
                <div
                  className="rounded-lg shadow-lg overflow-hidden"
                  style={{
                    backgroundColor: theme === "dark" ? "#16162a" : "#ffffff",
                    border: `1px solid ${theme === "dark" ? "#2a2a4a" : "#e5e7eb"}`,
                  }}
                >
                  {/* Header */}
                  <div
                    className="px-3 py-2.5 flex items-center gap-2"
                    style={{ backgroundColor: primaryColor }}
                  >
                    {logoUrl && (
                      <div className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center overflow-hidden">
                        <img
                          src={logoUrl}
                          alt=""
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      </div>
                    )}
                    <span
                      className="text-[11px] font-semibold"
                      style={{ color: "#ffffff" }}
                    >
                      {title || "Support"}
                    </span>
                  </div>

                  {/* Body */}
                  <div className="px-3 py-3">
                    <div
                      className="rounded-lg px-2.5 py-1.5 text-[10px] max-w-[80%]"
                      style={{
                        backgroundColor: theme === "dark" ? "#2a2a4a" : "#f3f4f6",
                        color: theme === "dark" ? "#d1d5db" : "#374151",
                      }}
                    >
                      {greeting || "Hi! How can I help?"}
                    </div>

                    {/* Suggested replies */}
                    {suggestedRepliesArray.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {suggestedRepliesArray.slice(0, 3).map((reply) => (
                          <span
                            key={reply}
                            className="text-[9px] px-2 py-0.5 rounded-full"
                            style={{
                              backgroundColor: `${primaryColor}15`,
                              color: primaryColor,
                              border: `1px solid ${primaryColor}30`,
                            }}
                          >
                            {reply}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Input bar */}
                  <div
                    className="px-3 py-2 border-t flex items-center gap-2"
                    style={{
                      borderColor: theme === "dark" ? "#2a2a4a" : "#e5e7eb",
                    }}
                  >
                    <div
                      className="flex-1 rounded px-2 py-1 text-[9px]"
                      style={{
                        backgroundColor: theme === "dark" ? "#1a1a2e" : "#f9fafb",
                        color: theme === "dark" ? "#6b7280" : "#9ca3af",
                        border: `1px solid ${theme === "dark" ? "#2a2a4a" : "#e5e7eb"}`,
                      }}
                    >
                      Type a message...
                    </div>
                    <div
                      className="w-5 h-5 rounded flex items-center justify-center"
                      style={{ backgroundColor: primaryColor }}
                    >
                      <MessageSquare size={10} className="text-white" />
                    </div>
                  </div>

                  {/* Branding */}
                  {!hidePoweredBy && (
                    <div
                      className="text-center py-1 text-[8px]"
                      style={{
                        color: theme === "dark" ? "#4b5563" : "#9ca3af",
                        borderTop: `1px solid ${theme === "dark" ? "#2a2a4a" : "#f3f4f6"}`,
                      }}
                    >
                      Powered by AgentOS
                    </div>
                  )}
                </div>

                {/* FAB button */}
                <div
                  className="w-10 h-10 rounded-full shadow-lg flex items-center justify-center mt-2"
                  style={{
                    backgroundColor: primaryColor,
                    alignSelf: position === "bottom-right" ? "flex-end" : "flex-start",
                  }}
                >
                  <MessageSquare size={18} className="text-white" />
                </div>
              </div>
            </div>
          </div>

          {/* Code Snippet */}
          <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide flex items-center gap-1.5">
            <Code size={12} /> Embed Code
          </h3>

          <div className="card p-0 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle bg-surface-overlay">
              <span className="text-[10px] font-medium text-text-muted uppercase tracking-wide">HTML</span>
              <button
                onClick={copySnippet}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium rounded-md transition-colors hover:bg-surface-base text-text-muted hover:text-text-primary"
              >
                {copied ? (
                  <>
                    <Check size={12} className="text-status-success" />
                    <span className="text-status-success">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy size={12} />
                    Copy
                  </>
                )}
              </button>
            </div>
            <pre className="p-3 overflow-x-auto text-[11px] font-mono leading-relaxed text-text-secondary bg-surface-base">
              <code>{snippet}</code>
            </pre>
          </div>

          {/* Instructions */}
          <div className="rounded-lg border border-border-subtle bg-surface-overlay p-3">
            <p className="text-xs font-medium text-text-secondary mb-2">Integration Instructions</p>
            <ol className="space-y-1.5 text-[11px] text-text-muted list-decimal list-inside">
              <li>Select an agent and API key above</li>
              <li>Customize the widget appearance</li>
              <li>Copy the embed code snippet</li>
              <li>
                Paste it before the closing{" "}
                <code className="px-1 py-0.5 rounded bg-surface-base border border-border-subtle text-[10px] font-mono">
                  {"</body>"}
                </code>{" "}
                tag on your website
              </li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
