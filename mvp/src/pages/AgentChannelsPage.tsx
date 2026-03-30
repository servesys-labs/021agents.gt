import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Globe, MessageSquare, Instagram, Phone, Mail, MessageCircle, Copy, Check, ExternalLink, Code, Loader2, Send, Hash, Key } from "lucide-react";
import { Button } from "../components/ui/Button";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { agentPathSegment } from "../lib/agent-path";
import { qrCodeImageUrl } from "../lib/chat-connect";

interface Channel {
  id: string;
  name: string;
  icon: React.ReactNode;
  description: string;
  status: "active" | "inactive" | "setup_required";
  config?: Record<string, string>;
  stats?: { conversations: number; messages: number };
}

interface BackendChannel {
  channel: string;
  agent_name: string;
  is_active: boolean;
  config: Record<string, unknown>;
}

const DEFAULT_CHANNELS: Channel[] = [
  {
    id: "web_widget", name: "Web Widget", icon: <Globe size={20} className="text-blue-500" />,
    description: "Embed a chat widget on your website", status: "setup_required",
  },
  {
    id: "telegram", name: "Telegram", icon: <Send size={20} className="text-sky-500" />,
    description: "DM your assistant; scan a QR to open your bot in Telegram", status: "setup_required",
  },
  {
    id: "whatsapp", name: "WhatsApp Business", icon: <MessageCircle size={20} className="text-green-500" />,
    description: "Auto-reply to WhatsApp messages via Cloud API", status: "setup_required",
  },
  {
    id: "slack", name: "Slack", icon: <Hash size={20} className="text-purple-600" />,
    description: "Respond in Slack channels and DMs", status: "setup_required",
  },
  {
    id: "instagram", name: "Instagram DMs", icon: <Instagram size={20} className="text-pink-500" />,
    description: "Auto-reply to Instagram direct messages", status: "setup_required",
  },
  {
    id: "messenger", name: "Facebook Messenger", icon: <MessageSquare size={20} className="text-blue-600" />,
    description: "Connect to your Facebook Page's Messenger", status: "setup_required",
  },
  {
    id: "sms", name: "SMS / Text", icon: <Phone size={20} className="text-purple-500" />,
    description: "Handle customer texts via Twilio or Vapi", status: "setup_required",
  },
  {
    id: "email", name: "Email", icon: <Mail size={20} className="text-orange-500" />,
    description: "Auto-respond to support emails", status: "setup_required",
  },
];

export default function AgentChannelsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [agentName, setAgentName] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [channels, setChannels] = useState<Channel[]>(DEFAULT_CHANNELS);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Widget config
  const [widgetPosition, setWidgetPosition] = useState("bottom-right");
  const [widgetColor, setWidgetColor] = useState("#2563eb");
  const [widgetGreeting, setWidgetGreeting] = useState("Hi! How can I help you today?");

  // Telegram
  const [telegramInfo, setTelegramInfo] = useState<{
    deep_link: string; bot_username: string; webhook_registered: boolean; webhook_url: string;
  } | null>(null);
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [telegramConnecting, setTelegramConnecting] = useState(false);
  const [telegramConnectError, setTelegramConnectError] = useState<string | null>(null);

  // WhatsApp
  const [waPhone, setWaPhone] = useState("");
  const [waPhoneNumberId, setWaPhoneNumberId] = useState("");
  const [waAccessToken, setWaAccessToken] = useState("");
  const [waConnecting, setWaConnecting] = useState(false);

  // Slack
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackTeamId, setSlackTeamId] = useState("");
  const [slackTeamName, setSlackTeamName] = useState("");
  const [slackConnecting, setSlackConnecting] = useState(false);

  // Instagram
  const [igPageToken, setIgPageToken] = useState("");
  const [igPageId, setIgPageId] = useState("");
  const [igUsername, setIgUsername] = useState("");
  const [igConnecting, setIgConnecting] = useState(false);

  // Messenger
  const [fbPageToken, setFbPageToken] = useState("");
  const [fbPageId, setFbPageId] = useState("");
  const [fbPageName, setFbPageName] = useState("");
  const [fbConnecting, setFbConnecting] = useState(false);

  // Email
  const [emailAddress, setEmailAddress] = useState("");
  const [emailProvider, setEmailProvider] = useState("gmail");

  // SMS
  const [smsPhone, setSmsPhone] = useState("");
  const [smsProvider, setSmsProvider] = useState("twilio");

  // Load agent + channel configs from backend
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);
        const agent = await api.get<{ name: string; agent_id?: string }>(`/agents/${agentPathSegment(id)}`);
        if (cancelled) return;
        setAgentName(agent.name ?? id);
        setAgentId(agent.agent_id || id);

        // Load saved channel configs
        try {
          const data = await api.get<{ channels: BackendChannel[] }>(`/chat/channels?agent_name=${encodeURIComponent(agent.name)}`);
          if (!cancelled && data.channels) {
            setChannels((prev) =>
              prev.map((ch) => {
                const saved = data.channels.find((s) => s.channel === ch.id);
                if (saved) {
                  return { ...ch, status: saved.is_active ? "active" : "inactive", config: saved.config as any };
                }
                return ch;
              }),
            );
          }
        } catch {
          /* channel_configs table may not exist yet */
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || "Failed to load agent");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [id]);

  const activeChannels = channels.filter((c) => c.status === "active");
  const totalConversations = activeChannels.reduce((s, c) => s + (c.stats?.conversations || 0), 0);

  const toggleChannel = async (channelId: string) => {
    const ch = channels.find((c) => c.id === channelId);
    if (!ch) return;
    const newActive = ch.status !== "active";
    setChannels((prev) => prev.map((c) => c.id === channelId ? { ...c, status: newActive ? "active" : "inactive" } : c));
    try {
      await api.put(`/chat/channels/${channelId}`, { is_active: newActive, config: ch.config || {} });
    } catch {}
  };

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
    toast("Copied to clipboard");
  };

  const saveChannelConfig = async (channelId: string, config: Record<string, unknown>) => {
    setSaving(true);
    try {
      await api.put(`/chat/channels/${channelId}`, { is_active: true, config, agent_name: agentName || "" });
      setChannels((prev) => prev.map((c) => c.id === channelId ? { ...c, status: "active", config: config as any } : c));
      setConfiguring(null);
      toast("Channel configured and activated!");
    } catch (err: any) {
      toast(err.message || "Failed to save channel config");
    } finally {
      setSaving(false);
    }
  };

  // ── Platform connect handlers ──

  const connectTelegramBot = async () => {
    const token = telegramBotToken.trim();
    if (!token) { setTelegramConnectError("Paste the bot token from BotFather first."); return; }
    setTelegramConnecting(true);
    setTelegramConnectError(null);
    try {
      const res = await api.post<{
        success: boolean; bot_username: string; deep_link: string;
        webhook_registered: boolean; webhook_url: string;
      }>("/chat/telegram/connect", { bot_token: token });

      let deepLink = res.deep_link;
      let username = res.bot_username;
      try {
        const qr = await api.get<{ deep_link: string; bot_username: string }>(
          `/chat/telegram/qr?agent_name=${encodeURIComponent(id || "")}`,
        );
        deepLink = qr.deep_link;
        username = qr.bot_username || username;
      } catch {}

      setTelegramInfo({ deep_link: deepLink, bot_username: username, webhook_registered: res.webhook_registered, webhook_url: res.webhook_url });
      await saveChannelConfig("telegram", { bot_username: username, deep_link: deepLink });
    } catch (err) {
      setTelegramConnectError(err instanceof Error ? err.message : "Could not connect Telegram");
    } finally {
      setTelegramConnecting(false);
    }
  };

  const connectWhatsApp = async () => {
    if (!waAccessToken.trim() || !waPhoneNumberId.trim()) return;
    setWaConnecting(true);
    try {
      const res = await api.post<{ ok: boolean; webhook_url: string }>("/chat/whatsapp/connect", {
        access_token: waAccessToken.trim(),
        phone_number_id: waPhoneNumberId.trim(),
        agent_name: agentName || "",
      });
      await saveChannelConfig("whatsapp", { phone: waPhone, phone_number_id: waPhoneNumberId, webhook_url: res.webhook_url });
      toast("WhatsApp connected! Set the webhook URL in Meta Business dashboard.");
    } catch (err: any) {
      toast(err.message || "Failed to connect WhatsApp");
    } finally {
      setWaConnecting(false);
    }
  };

  const connectSlack = async () => {
    if (!slackBotToken.trim() || !slackTeamId.trim()) return;
    setSlackConnecting(true);
    try {
      const res = await api.post<{ ok: boolean; webhook_url: string }>("/chat/slack/connect", {
        bot_token: slackBotToken.trim(),
        team_id: slackTeamId.trim(),
        team_name: slackTeamName.trim(),
        agent_name: agentName || "",
      });
      await saveChannelConfig("slack", { team_id: slackTeamId, team_name: slackTeamName, webhook_url: res.webhook_url });
      toast("Slack connected! Set the Events URL in your Slack app config.");
    } catch (err: any) {
      toast(err.message || "Failed to connect Slack");
    } finally {
      setSlackConnecting(false);
    }
  };

  const connectInstagram = async () => {
    if (!igPageToken.trim() || !igPageId.trim()) return;
    setIgConnecting(true);
    try {
      const res = await api.post<{ ok: boolean; webhook_url: string }>("/chat/instagram/connect", {
        page_token: igPageToken.trim(),
        page_id: igPageId.trim(),
        ig_username: igUsername.trim(),
        agent_name: agentName || "",
      });
      await saveChannelConfig("instagram", { ig_username: igUsername, page_id: igPageId, webhook_url: res.webhook_url });
      toast("Instagram connected! Set the webhook URL in Meta Developer console.");
    } catch (err: any) {
      toast(err.message || "Failed to connect Instagram");
    } finally {
      setIgConnecting(false);
    }
  };

  const connectMessenger = async () => {
    if (!fbPageToken.trim() || !fbPageId.trim()) return;
    setFbConnecting(true);
    try {
      const res = await api.post<{ ok: boolean; webhook_url: string }>("/chat/messenger/connect", {
        page_token: fbPageToken.trim(),
        page_id: fbPageId.trim(),
        page_name: fbPageName.trim(),
        agent_name: agentName || "",
      });
      await saveChannelConfig("messenger", { page_id: fbPageId, page_name: fbPageName, webhook_url: res.webhook_url });
      toast("Messenger connected! Set the webhook URL in Meta Developer console.");
    } catch (err: any) {
      toast(err.message || "Failed to connect Messenger");
    } finally {
      setFbConnecting(false);
    }
  };

  // Pre-load telegram QR when opening telegram modal
  useEffect(() => {
    if (configuring !== "telegram" || !id) return;
    let cancelled = false;
    setTelegramConnectError(null);
    (async () => {
      try {
        const qr = await api.get<{ deep_link: string; bot_username: string }>(`/chat/telegram/qr?agent_name=${encodeURIComponent(id)}`);
        if (cancelled) return;
        setTelegramInfo({ deep_link: qr.deep_link, bot_username: qr.bot_username, webhook_registered: true, webhook_url: "" });
      } catch { if (!cancelled) setTelegramInfo(null); }
    })();
    return () => { cancelled = true; };
  }, [configuring, id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={24} className="animate-spin text-primary" />
        <span className="ml-2 text-sm text-text-secondary">Loading channels...</span>
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

  const telegramDeepLink = telegramInfo?.deep_link ?? "";
  const waDigits = waPhone.replace(/\D/g, "");
  const whatsappDeepLink = waDigits
    ? `https://wa.me/${waDigits}?text=${encodeURIComponent("Hi — I'd like to use my OneShots assistant.")}`
    : "";

  const widgetSnippet = `<script src="https://oneshots.co/widget/${id}.js"
  data-position="${widgetPosition}"
  data-color="${widgetColor}"
  data-greeting="${widgetGreeting}">
</script>`;

  const apiEndpoint = `POST https://api.oneshots.co/v1/agents/${id}/chat
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json

{"message": "Hello", "session_id": "optional"}`;

  return (
    <div>
      <AgentNav agentName={agentName} />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card>
          <p className="text-xs text-text-secondary">Active Channels</p>
          <p className="text-xl font-semibold text-text">{activeChannels.length}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-secondary">Total Conversations</p>
          <p className="text-xl font-semibold text-text">{totalConversations}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-secondary">Available Channels</p>
          <p className="text-xl font-semibold text-text">{channels.length}</p>
        </Card>
      </div>

      {/* Channel list */}
      <div className="space-y-3">
        {channels.map((channel) => (
          <Card key={channel.id}>
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-lg bg-surface-alt flex items-center justify-center shrink-0">
                {channel.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-text">{channel.name}</h3>
                  <Badge variant={channel.status === "active" ? "success" : channel.status === "setup_required" ? "warning" : "default"}>
                    {channel.status === "setup_required" ? "Setup needed" : channel.status}
                  </Badge>
                </div>
                <p className="text-xs text-text-secondary mt-0.5">{channel.description}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {channel.status === "active" && (
                  <Button size="sm" variant="ghost" onClick={() => setConfiguring(channel.id)}>Configure</Button>
                )}
                {channel.status === "setup_required" && (
                  <Button size="sm" onClick={() => setConfiguring(channel.id)}>Set Up</Button>
                )}
                {channel.status === "inactive" && (
                  <Button size="sm" variant="secondary" onClick={() => setConfiguring(channel.id)}>Enable</Button>
                )}
                {(channel.status === "active" || channel.status === "inactive") && (
                  <button onClick={() => toggleChannel(channel.id)} className={`relative w-10 h-6 rounded-full transition-colors ${channel.status === "active" ? "bg-success" : "bg-surface-alt"}`}>
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-surface rounded-full shadow transition-transform ${channel.status === "active" ? "translate-x-4" : "translate-x-0"}`} />
                  </button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* API access */}
      <h2 className="text-lg font-medium text-text mt-8 mb-3">API Access</h2>
      <Card>
        <div className="flex items-center gap-3 mb-3">
          <Code size={18} className="text-text-secondary" />
          <div>
            <p className="text-sm font-medium text-text">REST API</p>
            <p className="text-xs text-text-secondary">Integrate your agent into any custom application</p>
          </div>
        </div>
        <div className="relative">
          <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs overflow-x-auto">{apiEndpoint}</pre>
          <button onClick={() => handleCopy(apiEndpoint, "api")} className="absolute top-2 right-2 p-1.5 rounded bg-gray-700 text-gray-300 hover:text-white">
            {copied === "api" ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs text-text-secondary">
          <Key size={14} />
          <span>Generate API keys in <button onClick={() => navigate(`/settings/api-keys`)} className="text-primary hover:underline">Settings → API Keys</button></span>
        </div>
      </Card>

      {/* ── Web Widget Modal ── */}
      <Modal open={configuring === "web_widget"} onClose={() => setConfiguring(null)} title="Web Widget Configuration" wide>
        <div className="space-y-4">
          <Select label="Position" value={widgetPosition} onChange={(e) => setWidgetPosition(e.target.value)}
            options={[{ value: "bottom-right", label: "Bottom right" }, { value: "bottom-left", label: "Bottom left" }]} />
          <Input label="Brand color" type="color" value={widgetColor} onChange={(e) => setWidgetColor(e.target.value)} />
          <Input label="Greeting message" value={widgetGreeting} onChange={(e) => setWidgetGreeting(e.target.value)} />
          <div>
            <p className="text-xs font-medium text-text-secondary mb-2">Embed code</p>
            <div className="relative">
              <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs overflow-x-auto">{widgetSnippet}</pre>
              <button onClick={() => handleCopy(widgetSnippet, "widget")} className="absolute top-2 right-2 p-1.5 rounded bg-gray-700 text-gray-300 hover:text-white">
                {copied === "widget" ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <p className="text-xs text-text-muted mt-2">Paste this before the closing &lt;/body&gt; tag on your website.</p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Close</Button>
            <Button disabled={saving} onClick={() => saveChannelConfig("web_widget", { position: widgetPosition, color: widgetColor, greeting: widgetGreeting })}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : null} Save
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Telegram Modal ── */}
      <Modal open={configuring === "telegram"} onClose={() => { setConfiguring(null); setTelegramConnectError(null); }} title="Telegram setup" wide>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary leading-relaxed">
            In <strong>@BotFather</strong>, create a bot and copy the <strong>HTTP API token</strong>.
            OneShots saves it securely, calls Telegram <code className="text-xs bg-surface-alt px-1 rounded">setWebhook</code>, then you can open the bot from the link or QR.
          </p>
          <Input label="Bot token (from BotFather)" type="password" autoComplete="off" placeholder="Paste token here"
            value={telegramBotToken} onChange={(e) => setTelegramBotToken(e.target.value)} />
          {telegramConnectError && <p className="text-sm text-danger bg-danger-light border border-danger rounded-lg px-3 py-2">{telegramConnectError}</p>}
          <Button onClick={connectTelegramBot} disabled={telegramConnecting}>
            {telegramConnecting ? <><Loader2 size={14} className="animate-spin" /> Connecting…</> : "Save token & register webhook"}
          </Button>
          {telegramInfo?.bot_username && (
            <p className="text-xs text-text-secondary">
              Bot @{telegramInfo.bot_username}
              {telegramInfo.webhook_url ? <> · Webhook: <code className="break-all">{telegramInfo.webhook_url}</code></> : null}
            </p>
          )}
          {telegramDeepLink ? (
            <div className="flex flex-col sm:flex-row gap-6 items-start pt-2 border-t border-border">
              <div className="rounded-lg border border-border p-2 bg-surface shrink-0">
                <img src={qrCodeImageUrl(telegramDeepLink, 180)} width={180} height={180} className="rounded" alt="Telegram QR" />
              </div>
              <div className="flex-1 min-w-0 space-y-2">
                <p className="text-xs font-medium text-text-secondary">Open on your phone</p>
                <code className="block text-xs bg-surface-alt rounded-lg p-3 break-all">{telegramDeepLink}</code>
                <Button size="sm" variant="secondary" onClick={() => handleCopy(telegramDeepLink, "tg")}>
                  {copied === "tg" ? <Check size={14} /> : <Copy size={14} />} Copy link
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-text-muted">After you save the token, the chat link and QR appear here.</p>
          )}
          <div className="flex justify-end"><Button variant="ghost" onClick={() => setConfiguring(null)}>Close</Button></div>
        </div>
      </Modal>

      {/* ── WhatsApp Modal ── */}
      <Modal open={configuring === "whatsapp"} onClose={() => setConfiguring(null)} title="WhatsApp Cloud API Setup" wide>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary leading-relaxed">
            Connect your WhatsApp Business number via Meta's <strong>Cloud API</strong>. You'll need an <em>access token</em> and <em>phone number ID</em> from the Meta Business dashboard.
          </p>
          <Input label="WhatsApp phone (display only)" placeholder="+15550000000" value={waPhone} onChange={(e) => setWaPhone(e.target.value)} />
          <Input label="Phone Number ID" placeholder="From Meta Business dashboard" value={waPhoneNumberId} onChange={(e) => setWaPhoneNumberId(e.target.value)} />
          <Input label="Permanent Access Token" type="password" placeholder="Paste your WhatsApp Cloud API access token" value={waAccessToken} onChange={(e) => setWaAccessToken(e.target.value)} />
          {whatsappDeepLink && (
            <div className="flex flex-col sm:flex-row gap-6 items-start">
              <div className="rounded-lg border border-border p-2 bg-surface shrink-0">
                <img src={qrCodeImageUrl(whatsappDeepLink, 180)} width={180} height={180} className="rounded" alt="WhatsApp QR" />
              </div>
              <div className="flex-1 min-w-0 space-y-2">
                <p className="text-xs text-text-secondary">Scan to open WhatsApp (manual greeting link). Automated replies use the Cloud API.</p>
                <code className="block text-xs bg-surface-alt rounded-lg p-3 break-all">{whatsappDeepLink}</code>
                <Button size="sm" variant="secondary" onClick={() => handleCopy(whatsappDeepLink, "wa")}>
                  {copied === "wa" ? <Check size={14} /> : <Copy size={14} />} Copy link
                </Button>
              </div>
            </div>
          )}
          <div className="bg-info-light rounded-lg p-3 text-xs text-info-dark">
            After connecting, set the webhook URL shown in the confirmation to <code>messages</code> field in your Meta app's WhatsApp settings.
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Cancel</Button>
            <Button onClick={connectWhatsApp} disabled={waConnecting || !waAccessToken.trim() || !waPhoneNumberId.trim()}>
              {waConnecting ? <><Loader2 size={14} className="animate-spin" /> Connecting…</> : "Connect WhatsApp"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Slack Modal ── */}
      <Modal open={configuring === "slack"} onClose={() => setConfiguring(null)} title="Slack Setup" wide>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary leading-relaxed">
            Create a <strong>Slack App</strong> at <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="text-primary hover:underline">api.slack.com/apps</a>,
            enable <em>Event Subscriptions</em> and <em>Bot Token Scopes</em> (<code className="text-xs">chat:write</code>, <code className="text-xs">app_mentions:read</code>, <code className="text-xs">im:history</code>),
            then install to your workspace.
          </p>
          <Input label="Bot User OAuth Token" type="password" placeholder="xoxb-..." value={slackBotToken} onChange={(e) => setSlackBotToken(e.target.value)} />
          <Input label="Team ID" placeholder="T01ABC123" value={slackTeamId} onChange={(e) => setSlackTeamId(e.target.value)} />
          <Input label="Workspace name (optional)" placeholder="My Company" value={slackTeamName} onChange={(e) => setSlackTeamName(e.target.value)} />
          <div className="bg-info-light rounded-lg p-3 text-xs text-info-dark">
            After connecting, set the <strong>Event Request URL</strong> in your Slack app to the webhook URL shown in the confirmation.
            Subscribe to <code>message.im</code> and <code>app_mention</code> events.
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Cancel</Button>
            <Button onClick={connectSlack} disabled={slackConnecting || !slackBotToken.trim() || !slackTeamId.trim()}>
              {slackConnecting ? <><Loader2 size={14} className="animate-spin" /> Connecting…</> : "Connect Slack"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Instagram Modal ── */}
      <Modal open={configuring === "instagram"} onClose={() => setConfiguring(null)} title="Instagram DMs Setup" wide>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary leading-relaxed">
            Connect your Instagram Business/Creator account. You need a <strong>Facebook Page</strong> linked to your Instagram account
            and a <em>Page Access Token</em> with <code className="text-xs">instagram_manage_messages</code> permission.
          </p>
          <Input label="Instagram username" placeholder="@yourbusiness" value={igUsername} onChange={(e) => setIgUsername(e.target.value)} />
          <Input label="Facebook Page ID" placeholder="From Meta Business Suite" value={igPageId} onChange={(e) => setIgPageId(e.target.value)} />
          <Input label="Page Access Token" type="password" placeholder="Paste token with instagram_manage_messages scope" value={igPageToken} onChange={(e) => setIgPageToken(e.target.value)} />
          <div className="bg-info-light rounded-lg p-3 text-xs text-info-dark">
            After connecting, add the webhook URL to your Meta app's Instagram settings, subscribing to the <code>messages</code> field.
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Cancel</Button>
            <Button onClick={connectInstagram} disabled={igConnecting || !igPageToken.trim() || !igPageId.trim()}>
              {igConnecting ? <><Loader2 size={14} className="animate-spin" /> Connecting…</> : <><ExternalLink size={14} /> Connect Instagram</>}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Facebook Messenger Modal ── */}
      <Modal open={configuring === "messenger"} onClose={() => setConfiguring(null)} title="Facebook Messenger Setup" wide>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary leading-relaxed">
            Connect your Facebook Page to auto-respond on Messenger. You need a <strong>Page Access Token</strong> with <code className="text-xs">pages_messaging</code> permission.
          </p>
          <Input label="Facebook Page ID" placeholder="From Page Settings → About" value={fbPageId} onChange={(e) => setFbPageId(e.target.value)} />
          <Input label="Page name (optional)" placeholder="My Business Page" value={fbPageName} onChange={(e) => setFbPageName(e.target.value)} />
          <Input label="Page Access Token" type="password" placeholder="Paste token with pages_messaging scope" value={fbPageToken} onChange={(e) => setFbPageToken(e.target.value)} />
          <div className="bg-info-light rounded-lg p-3 text-xs text-info-dark">
            After connecting, add the webhook URL to your Meta app's Messenger settings, subscribing to <code>messages</code> events.
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Cancel</Button>
            <Button onClick={connectMessenger} disabled={fbConnecting || !fbPageToken.trim() || !fbPageId.trim()}>
              {fbConnecting ? <><Loader2 size={14} className="animate-spin" /> Connecting…</> : "Connect Messenger"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── SMS Modal ── */}
      <Modal open={configuring === "sms"} onClose={() => setConfiguring(null)} title="SMS / Text Setup">
        <div className="space-y-4">
          <p className="text-sm text-text-secondary leading-relaxed">
            Connect a phone number for SMS. Uses your existing Vapi number or a Twilio number.
          </p>
          <Input label="Phone number (E.164)" placeholder="+15550000000" value={smsPhone} onChange={(e) => setSmsPhone(e.target.value)} />
          <Select label="Provider" value={smsProvider} onChange={(e) => setSmsProvider(e.target.value)}
            options={[{ value: "twilio", label: "Twilio" }, { value: "vapi", label: "Vapi (existing voice number)" }]} />
          <div className="bg-warning-light rounded-lg p-3 text-xs text-warning-dark">
            SMS integration requires a Twilio account or an existing Vapi phone number with SMS capability. Configure the SMS webhook URL in your provider dashboard after setup.
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Cancel</Button>
            <Button disabled={!smsPhone.trim()} onClick={() => saveChannelConfig("sms", { phone: smsPhone, provider: smsProvider })}>
              Save & Activate
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Email Modal ── */}
      <Modal open={configuring === "email"} onClose={() => setConfiguring(null)} title="Email Channel Setup">
        <div className="space-y-4">
          <Input label="Support email address" placeholder="support@yourbusiness.com" value={emailAddress} onChange={(e) => setEmailAddress(e.target.value)} />
          <Select label="Email provider" value={emailProvider} onChange={(e) => setEmailProvider(e.target.value)}
            options={[
              { value: "gmail", label: "Gmail / Google Workspace" },
              { value: "outlook", label: "Outlook / Microsoft 365" },
              { value: "custom", label: "Custom IMAP/SMTP" },
            ]} />
          <p className="text-xs text-text-muted">Your agent will monitor this inbox and auto-respond to customer emails.</p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Cancel</Button>
            <Button disabled={!emailAddress.trim()} onClick={() => saveChannelConfig("email", { address: emailAddress, provider: emailProvider })}>
              Connect Email
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
