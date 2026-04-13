/**
 * Agent Harness — React client.
 *
 * Built entirely on Cloudflare primitives:
 * - useAgent (agents/react) for WebSocket connection
 * - useAgentChat (@cloudflare/ai-chat/react) for chat protocol
 * - @cloudflare/kumo for UI components
 * - @phosphor-icons/react for icons
 */

import {
  Suspense,
  useCallback,
  useState,
  useEffect,
  useRef,
  useMemo,
  type FormEvent,
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import type { MCPServersState } from "agents";
import {
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text,
  Input,
  Label,
  PoweredByCloudflare,
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  CheckCircleIcon,
  XCircleIcon,
  GearIcon,
  CloudSunIcon,
  PlugsConnectedIcon,
  PlusIcon,
  SignInIcon,
  XIcon,
  WrenchIcon,
  MoonIcon,
  SunIcon,
  LockKeyIcon,
  CaretDownIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";

// ── Types ────────────────────────────────────────────────────────────────────

type Tenant = {
  id: string;
  name: string;
  icon: string;
  description: string;
  dynamic?: boolean;
};

type DynamicAgent = {
  agent_id: string;
  name: string;
  icon: string;
  description: string;
  model: string;
  enable_sandbox: number;
  created_at: string;
};

type ConnectionStatus = "connecting" | "connected" | "disconnected";

// ── Terminal panel ────────────────────────────────────────────────────────────

function TerminalPanel({ onClose }: { onClose: () => void }) {
  const termContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<any>(null);
  const addonRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const [termState, setTermState] = useState<"disconnected" | "connecting" | "connected">("disconnected");

  useEffect(() => {
    let disposed = false;

    async function initTerminal() {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { SandboxAddon } = await import("@cloudflare/sandbox/xterm");

      // Dynamic import for xterm CSS
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css";
      document.head.appendChild(link);

      if (disposed || !termContainerRef.current) return;

      const term = new Terminal({
        theme: {
          background: "#0a0a0a",
          foreground: "#e4e4e7",
          cursor: "#a78bfa",
          selectionBackground: "rgba(167, 139, 250, 0.3)",
        },
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        fontSize: 13,
        cursorBlink: true,
        convertEol: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const sandboxAddon = new SandboxAddon({
        getWebSocketUrl: ({ origin }) => {
          // Replace http/https with ws/wss
          const wsOrigin = origin.replace(/^http/, "ws");
          return `${wsOrigin}/api/terminal`;
        },
        reconnect: true,
        onStateChange: (state: string, error?: Error) => {
          setTermState(state as any);
          if (error) {
            console.error("Terminal connection error:", error);
          }
        },
      });

      term.loadAddon(sandboxAddon);
      term.open(termContainerRef.current);
      fitAddon.fit();

      // Connect to the coding sandbox
      sandboxAddon.connect({ sandboxId: "coding-sandbox" });

      terminalRef.current = term;
      addonRef.current = sandboxAddon;
      fitAddonRef.current = fitAddon;

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        if (fitAddonRef.current) {
          try {
            fitAddonRef.current.fit();
          } catch {}
        }
      });
      resizeObserver.observe(termContainerRef.current);

      return () => {
        resizeObserver.disconnect();
      };
    }

    initTerminal();

    return () => {
      disposed = true;
      if (addonRef.current) {
        addonRef.current.disconnect();
        addonRef.current.dispose();
      }
      if (terminalRef.current) {
        terminalRef.current.dispose();
      }
    };
  }, []);

  const stateColor = termState === "connected" ? "text-green-500" : termState === "connecting" ? "text-yellow-500" : "text-red-500";

  return (
    <div className="border-t border-kumo-line bg-[#0a0a0a] flex flex-col" style={{ height: "280px" }}>
      <div className="flex items-center justify-between px-3 py-1.5 bg-kumo-base border-b border-kumo-line">
        <div className="flex items-center gap-2">
          <TerminalWindowIcon size={14} className="text-kumo-accent" />
          <Text size="xs" bold>Sandbox Terminal</Text>
          <span className={`text-[10px] ${stateColor}`}>
            {termState === "connected" ? "●" : termState === "connecting" ? "○" : "●"} {termState}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          aria-label="Close terminal"
          icon={<XIcon size={12} />}
          onClick={onClose}
        />
      </div>
      <div ref={termContainerRef} className="flex-1 overflow-hidden p-1" />
    </div>
  );
}

// ── Auth helpers ─────────────────────────────────────────────────────────────

function isLoggedIn(): boolean {
  // Session is cookie-based (HttpOnly), so we check via a flag
  return localStorage.getItem("agent_logged_in") === "true";
}

async function login(code: string): Promise<boolean> {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    credentials: "include",
  });
  if (res.ok) {
    localStorage.setItem("agent_logged_in", "true");
    return true;
  }
  return false;
}

function logout() {
  localStorage.removeItem("agent_logged_in");
  // Clear cookie by reloading — server will see no valid session
  document.cookie = "agent_session=; Path=/; Max-Age=0";
  window.location.reload();
}

// ── Shared components ────────────────────────────────────────────────────────

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  const text =
    status === "connected"
      ? "text-kumo-success"
      : status === "connecting"
        ? "text-kumo-warning"
        : "text-kumo-danger";
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";
  return (
    <div className="flex items-center gap-2" role="status">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className={`text-xs ${text}`}>{label}</span>
    </div>
  );
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "dark"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

// ── Login screen ─────────────────────────────────────────────────────────────

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setError(null);
      setLoading(true);

      try {
        const ok = await login(code.trim());
        if (ok) {
          onSuccess();
        } else {
          setError("Invalid access code");
        }
      } catch {
        setError("Connection error");
      } finally {
        setLoading(false);
      }
    },
    [code, onSuccess]
  );

  return (
    <div className="flex flex-col min-h-screen bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="flex items-center justify-end">
          <ModeToggle />
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center p-6">
        <Surface className="w-full max-w-sm rounded-2xl ring ring-kumo-line p-8 space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-kumo-accent/10 mb-2">
              <LockKeyIcon size={24} className="text-kumo-accent" />
            </div>
            <Text size="lg" bold>
              Agent Harness
            </Text>
            <Text size="sm" variant="secondary">
              Enter the access code to continue
            </Text>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="code">Access Code</Label>
              <Input
                id="code"
                type="password"
                value={code}
                onValueChange={setCode}
                placeholder="Enter code"
                disabled={loading}
              />
            </div>

            {error && (
              <span style={{ color: '#ef4444', fontSize: '0.875rem' }}>
                {error}
              </span>
            )}

            <Button
              type="submit"
              variant="primary"
              className="w-full"
              disabled={!code.trim() || loading}
            >
              {loading ? "Verifying..." : "Enter"}
            </Button>
          </form>
        </Surface>
      </div>
    </div>
  );
}

// ── Tenant selector ──────────────────────────────────────────────────────────

function TenantSelector({
  tenants,
  current,
  onSelect,
}: {
  tenants: Tenant[];
  current: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = tenants.find((t) => t.id === current) ?? tenants[0];

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="secondary"
        onClick={() => setOpen(!open)}
      >
        <span className="mr-1">{active.icon}</span>
        {active.name}
        <CaretDownIcon size={12} className="ml-1" />
      </Button>

      {open && (
        <div className="absolute left-0 top-full mt-2 w-72 z-50">
          <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-2 space-y-1">
            {tenants.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  onSelect(t.id);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                  t.id === current
                    ? "bg-kumo-accent/10 text-kumo-accent"
                    : "hover:bg-kumo-elevated text-kumo-default"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg">{t.icon}</span>
                  <div>
                    <div className="text-sm font-medium">{t.name}</div>
                    <div className="text-xs text-kumo-subtle">
                      {t.description}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </Surface>
        </div>
      )}
    </div>
  );
}

// ── Chat screen ──────────────────────────────────────────────────────────────

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const [tenantId, setTenantId] = useState(
    () => localStorage.getItem("agent_tenant") || "default"
  );
  const [tenants] = useState<Tenant[]>([
    {
      id: "default",
      name: "General Assistant",
      icon: "✦",
      description: "General purpose AI assistant",
    },
    {
      id: "coding",
      name: "Coding Agent",
      icon: "⌨",
      description: "Code review, debugging & architecture",
    },
    {
      id: "support",
      name: "Customer Support",
      icon: "◎",
      description: "Empathetic support & troubleshooting",
    },
    {
      id: "research",
      name: "Research Analyst",
      icon: "◈",
      description: "Analysis, synthesis & insights",
    },
  ]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Terminal state (only for coding tenant)
  const [showTerminal, setShowTerminal] = useState(false);
  const isCodingTenant = tenantId === "coding";

  // MCP state
  const [mcpState, setMcpState] = useState<MCPServersState>({
    prompts: [],
    resources: [],
    servers: {},
    tools: [],
  });
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [isAddingServer, setIsAddingServer] = useState(false);
  const mcpPanelRef = useRef<HTMLDivElement>(null);

  // Save tenant selection
  useEffect(() => {
    localStorage.setItem("agent_tenant", tenantId);
  }, [tenantId]);

  // ── useAgent: WebSocket connection to the Durable Object ──
  const agent = useAgent({
    agent: "ChatAgent",
    name: tenantId,
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onMcpUpdate: useCallback((state: MCPServersState) => {
      setMcpState(state);
    }, []),
  });

  // ── useAgentChat: chat protocol, message persistence, streaming ──
  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    isStreaming,
  } = useAgentChat({
    agent,
    onToolCall: async ({ toolCall, addToolOutput }) => {
      if (toolCall.toolName === "getUserTimezone") {
        addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            localTime: new Date().toLocaleTimeString(),
          },
        });
      }
    },
  });

  const isConnected = connectionStatus === "connected";

  // Close MCP panel on outside click
  useEffect(() => {
    if (!showMcpPanel) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        mcpPanelRef.current &&
        !mcpPanelRef.current.contains(e.target as Node)
      ) {
        setShowMcpPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMcpPanel]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleAddServer = async () => {
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    setIsAddingServer(true);
    try {
      await agent.call("addServer", [mcpName.trim(), mcpUrl.trim()]);
      setMcpName("");
      setMcpUrl("");
    } catch (e) {
      console.error("Failed to add MCP server:", e);
    } finally {
      setIsAddingServer(false);
    }
  };

  const handleRemoveServer = async (serverId: string) => {
    try {
      await agent.call("removeServer", [serverId]);
    } catch (e) {
      console.error("Failed to remove MCP server:", e);
    }
  };

  const serverEntries = Object.entries(mcpState.servers);
  const mcpToolCount = mcpState.tools.length;

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  const activeTenant = tenants.find((t) => t.id === tenantId) ?? tenants[0];

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <TenantSelector
              tenants={tenants}
              current={tenantId}
              onSelect={setTenantId}
            />
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />

            {/* MCP Panel */}
            <div className="relative" ref={mcpPanelRef}>
              <Button
                variant="secondary"
                icon={<PlugsConnectedIcon size={16} />}
                onClick={() => setShowMcpPanel(!showMcpPanel)}
              >
                MCP
                {mcpToolCount > 0 && (
                  <Badge variant="primary" className="ml-1.5">
                    <WrenchIcon size={10} className="mr-0.5" />
                    {mcpToolCount}
                  </Badge>
                )}
              </Button>

              {showMcpPanel && (
                <div className="absolute right-0 top-full mt-2 w-96 z-50">
                  <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <PlugsConnectedIcon
                          size={16}
                          className="text-kumo-accent"
                        />
                        <Text size="sm" bold>
                          MCP Servers
                        </Text>
                        {serverEntries.length > 0 && (
                          <Badge variant="secondary">
                            {serverEntries.length}
                          </Badge>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        aria-label="Close MCP panel"
                        icon={<XIcon size={14} />}
                        onClick={() => setShowMcpPanel(false)}
                      />
                    </div>

                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleAddServer();
                      }}
                      className="space-y-2"
                    >
                      <input
                        type="text"
                        value={mcpName}
                        onChange={(e) => setMcpName(e.target.value)}
                        placeholder="Server name"
                        className="w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
                      />
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={mcpUrl}
                          onChange={(e) => setMcpUrl(e.target.value)}
                          placeholder="https://mcp.example.com"
                          className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent font-mono"
                        />
                        <Button
                          type="submit"
                          variant="primary"
                          size="sm"
                          icon={<PlusIcon size={14} />}
                          disabled={
                            isAddingServer || !mcpName.trim() || !mcpUrl.trim()
                          }
                        >
                          {isAddingServer ? "..." : "Add"}
                        </Button>
                      </div>
                    </form>

                    {serverEntries.length > 0 && (
                      <div className="space-y-2 max-h-60 overflow-y-auto">
                        {serverEntries.map(([id, server]) => (
                          <div
                            key={id}
                            className="flex items-start justify-between p-2.5 rounded-lg border border-kumo-line"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-kumo-default truncate">
                                  {server.name}
                                </span>
                                <Badge
                                  variant={
                                    server.state === "ready"
                                      ? "primary"
                                      : server.state === "failed"
                                        ? "destructive"
                                        : "secondary"
                                  }
                                >
                                  {server.state}
                                </Badge>
                              </div>
                              <span className="text-xs font-mono text-kumo-subtle truncate block mt-0.5">
                                {server.server_url}
                              </span>
                              {server.state === "failed" && server.error && (
                                <span className="text-xs text-red-500 block mt-0.5">
                                  {server.error}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0 ml-2">
                              {server.state === "authenticating" &&
                                server.auth_url && (
                                  <Button
                                    variant="primary"
                                    size="sm"
                                    icon={<SignInIcon size={12} />}
                                    onClick={() =>
                                      window.open(
                                        server.auth_url as string,
                                        "oauth",
                                        "width=600,height=800"
                                      )
                                    }
                                  >
                                    Auth
                                  </Button>
                                )}
                              <Button
                                variant="ghost"
                                size="sm"
                                shape="square"
                                aria-label="Remove server"
                                icon={<TrashIcon size={12} />}
                                onClick={() => handleRemoveServer(id)}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {mcpToolCount > 0 && (
                      <div className="pt-2 border-t border-kumo-line">
                        <div className="flex items-center gap-2">
                          <WrenchIcon size={14} className="text-kumo-subtle" />
                          <span className="text-xs text-kumo-subtle">
                            {mcpToolCount} tool
                            {mcpToolCount !== 1 ? "s" : ""} available from MCP
                            servers
                          </span>
                        </div>
                      </div>
                    )}
                  </Surface>
                </div>
              )}
            </div>

            {/* Terminal toggle (coding agent only) */}
            {isCodingTenant && (
              <Button
                variant={showTerminal ? "primary" : "secondary"}
                icon={<TerminalWindowIcon size={16} />}
                onClick={() => setShowTerminal(!showTerminal)}
              >
                Terminal
              </Button>
            )}

            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<span className="text-3xl">{activeTenant.icon}</span>}
              title={activeTenant.name}
              description={`${activeTenant.description}. Try "What's the weather in London?" or "What timezone am I in?"`}
            />
          )}

          {messages.map((message, index) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;

            if (isUser) {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                    {getMessageText(message)}
                  </div>
                </div>
              );
            }

            return (
              <div key={message.id} className="space-y-2">
                {message.parts.map((part, partIndex) => {
                  if (part.type === "text") {
                    if (!part.text) return null;
                    const isLastTextPart = message.parts
                      .slice(partIndex + 1)
                      .every((p) => p.type !== "text");
                    return (
                      <div key={partIndex} className="flex justify-start">
                        <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                          <div className="whitespace-pre-wrap">
                            {part.text}
                            {isLastAssistant &&
                              isLastTextPart &&
                              isStreaming && (
                                <span className="inline-block w-0.5 h-[1em] bg-kumo-brand ml-0.5 align-text-bottom animate-blink-cursor" />
                              )}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  if (part.type === "reasoning") {
                    if (!part.text) return null;
                    return (
                      <div key={partIndex} className="flex justify-start">
                        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line opacity-70">
                          <div className="flex items-center gap-2 mb-1">
                            <GearIcon
                              size={14}
                              className="text-kumo-inactive"
                            />
                            <Text size="xs" variant="secondary" bold>
                              Thinking
                            </Text>
                          </div>
                          <div className="whitespace-pre-wrap text-xs text-kumo-subtle italic">
                            {part.text}
                          </div>
                        </Surface>
                      </div>
                    );
                  }

                  if (!isToolUIPart(part)) return null;
                  const toolName = getToolName(part);

                  if (part.state === "output-available") {
                    return (
                      <div key={part.toolCallId} className="flex justify-start">
                        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                          <div className="flex items-center gap-2 mb-1">
                            <GearIcon
                              size={14}
                              className="text-kumo-inactive"
                            />
                            <Text size="xs" variant="secondary" bold>
                              {toolName}
                            </Text>
                            <Badge variant="secondary">Done</Badge>
                          </div>
                          <div className="font-mono">
                            <Text size="xs" variant="secondary">
                              {JSON.stringify(part.output, null, 2)}
                            </Text>
                          </div>
                        </Surface>
                      </div>
                    );
                  }

                  if (
                    "approval" in part &&
                    part.state === "approval-requested"
                  ) {
                    const approvalId = (part.approval as { id?: string })?.id;
                    return (
                      <div key={part.toolCallId} className="flex justify-start">
                        <Surface className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning">
                          <div className="flex items-center gap-2 mb-2">
                            <GearIcon size={14} className="text-kumo-warning" />
                            <Text size="sm" bold>
                              Approval needed: {toolName}
                            </Text>
                          </div>
                          <div className="font-mono mb-3">
                            <Text size="xs" variant="secondary">
                              {JSON.stringify(part.input, null, 2)}
                            </Text>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="primary"
                              size="sm"
                              icon={<CheckCircleIcon size={14} />}
                              onClick={() => {
                                if (approvalId) {
                                  addToolApprovalResponse({
                                    id: approvalId,
                                    approved: true,
                                  });
                                }
                              }}
                            >
                              Approve
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<XCircleIcon size={14} />}
                              onClick={() => {
                                if (approvalId) {
                                  addToolApprovalResponse({
                                    id: approvalId,
                                    approved: false,
                                  });
                                }
                              }}
                            >
                              Reject
                            </Button>
                          </div>
                        </Surface>
                      </div>
                    );
                  }

                  if (part.state === "output-denied") {
                    return (
                      <div key={part.toolCallId} className="flex justify-start">
                        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                          <div className="flex items-center gap-2">
                            <XCircleIcon
                              size={14}
                              className="text-kumo-inactive"
                            />
                            <Text size="xs" variant="secondary" bold>
                              {toolName}
                            </Text>
                            <Badge variant="secondary">Denied</Badge>
                          </div>
                        </Surface>
                      </div>
                    );
                  }

                  if (
                    part.state === "input-available" ||
                    part.state === "input-streaming"
                  ) {
                    return (
                      <div key={part.toolCallId} className="flex justify-start">
                        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                          <div className="flex items-center gap-2">
                            <GearIcon
                              size={14}
                              className="text-kumo-inactive animate-spin"
                            />
                            <Text size="xs" variant="secondary">
                              Running {toolName}...
                            </Text>
                          </div>
                        </Surface>
                      </div>
                    );
                  }

                  return null;
                })}
              </div>
            );
          })}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Terminal panel (coding agent only) */}
      {isCodingTenant && showTerminal && (
        <TerminalPanel onClose={() => setShowTerminal(false)} />
      )}

      {/* Input */}
      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <InputArea
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={`Ask ${activeTenant.name} anything...`}
              disabled={!isConnected || isStreaming}
              rows={2}
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop streaming"
                onClick={stop}
                icon={<StopIcon size={18} weight="fill" />}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={!input.trim() || !isConnected}
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            )}
          </div>
        </form>
        <div className="flex justify-center pb-3">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </div>
    </div>
  );
}

// ── App root ─────────────────────────────────────────────────────────────────

export default function App() {
  const [authed, setAuthed] = useState(isLoggedIn);

  if (!authed) {
    return <LoginScreen onSuccess={() => setAuthed(true)} />;
  }

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}
