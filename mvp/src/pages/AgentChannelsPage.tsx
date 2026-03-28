import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Globe, MessageSquare, Instagram, Phone, Mail, MessageCircle, Copy, Check, ExternalLink, Code, Loader2, Send, Hash } from "lucide-react";
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

export default function AgentChannelsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [agentName, setAgentName] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [channels, setChannels] = useState<Channel[]>([
    {
      id: "web_widget", name: "Web Widget", icon: <Globe size={20} className="text-blue-500" />,
      description: "Embed a chat widget on your website", status: "active",
      config: { position: "bottom-right", color: "#2563eb" },
    },
    {
      id: "telegram", name: "Telegram", icon: <Send size={20} className="text-sky-500" />,
      description: "DM your assistant; scan a QR to open your bot in Telegram",
      status: "setup_required",
    },
    {
      id: "whatsapp", name: "WhatsApp Business", icon: <MessageCircle size={20} className="text-green-500" />,
      description: "WhatsApp chat link + QR (Business API / Cloud API)",
      status: "setup_required",
    },
    {
      id: "slack", name: "Slack", icon: <Hash size={20} className="text-purple-600" />,
      description: "OAuth install link + QR for your workspace",
      status: "setup_required",
    },
    {
      id: "instagram", name: "Instagram DMs", icon: <Instagram size={20} className="text-pink-500" />,
      description: "Auto-reply to Instagram direct messages", status: "setup_required",
    },
    {
      id: "sms", name: "SMS / Text", icon: <Phone size={20} className="text-purple-500" />,
      description: "Handle customer texts via Twilio or Vapi", status: "inactive",
    },
    {
      id: "email", name: "Email", icon: <Mail size={20} className="text-orange-500" />,
      description: "Auto-respond to support emails", status: "setup_required",
    },
    {
      id: "messenger", name: "Facebook Messenger", icon: <MessageSquare size={20} className="text-blue-600" />,
      description: "Connect to your Facebook Page's Messenger", status: "inactive",
    },
  ]);

  const [configuring, setConfiguring] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Widget config
  const [widgetPosition, setWidgetPosition] = useState("bottom-right");
  const [widgetColor, setWidgetColor] = useState("#2563eb");
  const [widgetGreeting, setWidgetGreeting] = useState("Hi! How can I help you today?");

  // WhatsApp config
  const [waPhone, setWaPhone] = useState("");
  const [waApiKey, setWaApiKey] = useState("");

  /** After POST /chat/telegram/connect + optional GET /chat/telegram/qr */
  const [telegramInfo, setTelegramInfo] = useState<{
    deep_link: string;
    bot_username: string;
    webhook_registered: boolean;
    webhook_url: string;
  } | null>(null);
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [telegramConnecting, setTelegramConnecting] = useState(false);
  const [telegramConnectError, setTelegramConnectError] = useState<string | null>(null);
  const [slackInstallUrl, setSlackInstallUrl] = useState("");

  // Instagram config
  const [igAccount, setIgAccount] = useState("");

  // Email config
  const [emailAddress, setEmailAddress] = useState("");
  const [emailProvider, setEmailProvider] = useState("gmail");

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);
        const agent = await api.get<{ name: string; id?: string }>(`/agents/${agentPathSegment(id)}`);
        if (cancelled) return;
        setAgentName(agent.name ?? id);
        setAgentId(agent.id || id);
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

  const toggleChannel = (channelId: string) => {
    setChannels((prev) =>
      prev.map((c) => {
        if (c.id !== channelId) return c;
        return { ...c, status: c.status === "active" ? "inactive" : "active" };
      }),
    );
  };

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
    toast("Copied to clipboard");
  };

  const saveConfig = (channelId: string) => {
    setChannels((prev) =>
      prev.map((c) => (c.id === channelId ? { ...c, status: "active" } : c)),
    );
    setConfiguring(null);
    toast("Channel configured and activated!");
  };

  const connectTelegramBot = async () => {
    const token = telegramBotToken.trim();
    if (!token) {
      setTelegramConnectError("Paste the bot token from BotFather first.");
      return;
    }
    if (!id) return;
    setTelegramConnecting(true);
    setTelegramConnectError(null);
    try {
      const res = await api.post<{
        success: boolean;
        bot_username: string;
        deep_link: string;
        webhook_registered: boolean;
        webhook_url: string;
      }>("/chat/telegram/connect", { bot_token: token });

      let deepLink = res.deep_link;
      let username = res.bot_username;
      try {
        const qr = await api.get<{ deep_link: string; bot_username: string }>(
          `/chat/telegram/qr?agent_name=${encodeURIComponent(id)}`,
        );
        deepLink = qr.deep_link;
        username = qr.bot_username || username;
      } catch {
        /* token stored but qr endpoint unavailable or scope — use connect response */
      }

      setTelegramInfo({
        deep_link: deepLink,
        bot_username: username,
        webhook_registered: res.webhook_registered,
        webhook_url: res.webhook_url,
      });
      setChannels((prev) => prev.map((c) => (c.id === "telegram" ? { ...c, status: "active" } : c)));
      toast("Telegram bot connected — webhook registered with Telegram.");
    } catch (err) {
      setTelegramConnectError(err instanceof Error ? err.message : "Could not connect Telegram");
    } finally {
      setTelegramConnecting(false);
    }
  };

  useEffect(() => {
    if (configuring !== "telegram" || !id) return;
    let cancelled = false;
    setTelegramConnectError(null);
    (async () => {
      try {
        const qr = await api.get<{ deep_link: string; bot_username: string; instructions?: string }>(
          `/chat/telegram/qr?agent_name=${encodeURIComponent(id)}`,
        );
        if (cancelled) return;
        setTelegramInfo({
          deep_link: qr.deep_link,
          bot_username: qr.bot_username,
          webhook_registered: true,
          webhook_url: "",
        });
      } catch {
        if (!cancelled) setTelegramInfo(null);
      }
    })();
    return () => {
      cancelled = true;
    };
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
    ? `https://wa.me/${waDigits}?text=${encodeURIComponent("Hi — I'd like to use my AgentOS assistant.")}`
    : "";
  const slackUrlTrimmed = slackInstallUrl.trim();

  const widgetSnippet = `<script src="https://agentos.dev/widget/${id}.js"
  data-position="${widgetPosition}"
  data-color="${widgetColor}"
  data-greeting="${widgetGreeting}">
</script>`;

  const apiEndpoint = `POST https://api.agentos.dev/v1/agents/${id}/chat
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
                  <Badge
                    variant={
                      channel.status === "active" ? "success" : channel.status === "setup_required" ? "warning" : "default"
                    }
                  >
                    {channel.status === "setup_required" ? "Setup needed" : channel.status}
                  </Badge>
                </div>
                <p className="text-xs text-text-secondary mt-0.5">{channel.description}</p>
                {channel.stats && channel.status === "active" && (
                  <p className="text-xs text-text-muted mt-1">
                    {channel.stats.conversations} conversations · {channel.stats.messages} messages
                  </p>
                )}
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
                {channel.status === "active" && (
                  <button
                    onClick={() => toggleChannel(channel.id)}
                    className="relative w-10 h-6 rounded-full bg-success transition-colors"
                  >
                    <span className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow translate-x-4 transition-transform" />
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
          <button
            onClick={() => handleCopy(apiEndpoint, "api")}
            className="absolute top-2 right-2 p-1.5 rounded bg-gray-700 text-gray-300 hover:text-white"
          >
            {copied === "api" ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </Card>

      {/* Web Widget config modal */}
      <Modal open={configuring === "web_widget"} onClose={() => setConfiguring(null)} title="Web Widget Configuration" wide>
        <div className="space-y-4">
          <Select
            label="Position"
            value={widgetPosition}
            onChange={(e) => setWidgetPosition(e.target.value)}
            options={[
              { value: "bottom-right", label: "Bottom right" },
              { value: "bottom-left", label: "Bottom left" },
            ]}
          />
          <Input label="Brand color" type="color" value={widgetColor} onChange={(e) => setWidgetColor(e.target.value)} />
          <Input label="Greeting message" value={widgetGreeting} onChange={(e) => setWidgetGreeting(e.target.value)} />

          <div>
            <p className="text-xs font-medium text-text-secondary mb-2">Embed code</p>
            <div className="relative">
              <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs overflow-x-auto">{widgetSnippet}</pre>
              <button
                onClick={() => handleCopy(widgetSnippet, "widget")}
                className="absolute top-2 right-2 p-1.5 rounded bg-gray-700 text-gray-300 hover:text-white"
              >
                {copied === "widget" ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <p className="text-xs text-text-muted mt-2">
              Paste this before the closing &lt;/body&gt; tag on your website.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Close</Button>
            <Button onClick={() => saveConfig("web_widget")}>Save</Button>
          </div>
        </div>
      </Modal>

      {/* Telegram — BotFather token → control plane stores + setWebhook; QR uses real t.me link */}
      <Modal
        open={configuring === "telegram"}
        onClose={() => {
          setConfiguring(null);
          setTelegramConnectError(null);
        }}
        title="Telegram setup"
        wide
      >
        <div className="space-y-4">
          <p className="text-sm text-text-secondary leading-relaxed">
            In <strong>@BotFather</strong>, create a bot and copy the <strong>HTTP API token</strong> (long string like{" "}
            <code className="text-xs bg-surface-alt px-1 rounded">123456:ABC...</code>). AgentOS saves it securely, calls Telegram{" "}
            <code className="text-xs bg-surface-alt px-1 rounded">setWebhook</code>, then you can open the bot from the link or QR.
            The username alone is not enough—Telegram needs the token on the server to receive and send messages.
          </p>
          <Input
            label="Bot token (from BotFather)"
            type="password"
            autoComplete="off"
            placeholder="Paste token here"
            value={telegramBotToken}
            onChange={(e) => setTelegramBotToken(e.target.value)}
          />
          {telegramConnectError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{telegramConnectError}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={connectTelegramBot} disabled={telegramConnecting}>
              {telegramConnecting ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Connecting…
                </>
              ) : (
                "Save token & register webhook"
              )}
            </Button>
          </div>
          {telegramInfo?.bot_username && (
            <p className="text-xs text-text-secondary">
              Bot @{telegramInfo.bot_username}
              {telegramInfo.webhook_url ? (
                <>
                  {" "}
                  · Webhook URL: <code className="break-all">{telegramInfo.webhook_url}</code>
                </>
              ) : null}
              {telegramInfo.webhook_url && telegramInfo.webhook_registered === false ? (
                <span className="text-amber-700"> · Webhook may not have registered—check control plane logs and RUNTIME_WORKER_URL.</span>
              ) : null}
            </p>
          )}
          {telegramDeepLink ? (
            <div className="flex flex-col sm:flex-row gap-6 items-start pt-2 border-t border-border">
              <div className="rounded-lg border border-border p-2 bg-white shrink-0">
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
            <p className="text-xs text-text-muted">After you save the token, the chat link and QR appear here (or reload this panel if a token is already stored).</p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Close</Button>
          </div>
        </div>
      </Modal>

      {/* WhatsApp — wa.me + QR + API key */}
      <Modal open={configuring === "whatsapp"} onClose={() => setConfiguring(null)} title="WhatsApp setup" wide>
        <div className="space-y-4">
          <Input label="WhatsApp Business phone (E.164)" placeholder="+15550000000" value={waPhone} onChange={(e) => setWaPhone(e.target.value)} />
          <Input label="WhatsApp Cloud / Business API token (optional)" type="password" placeholder="For server-side routing" value={waApiKey} onChange={(e) => setWaApiKey(e.target.value)} />
          {whatsappDeepLink ? (
            <div className="flex flex-col sm:flex-row gap-6 items-start">
              <div className="rounded-lg border border-border p-2 bg-white shrink-0">
                <img src={qrCodeImageUrl(whatsappDeepLink, 180)} width={180} height={180} className="rounded" alt="WhatsApp QR" />
              </div>
              <div className="flex-1 min-w-0 space-y-2">
                <p className="text-xs text-text-secondary">Scan to open WhatsApp with a prefilled message. Complete Cloud API credentials in the control plane for automation.</p>
                <code className="block text-xs bg-surface-alt rounded-lg p-3 break-all">{whatsappDeepLink}</code>
                <Button size="sm" variant="secondary" onClick={() => handleCopy(whatsappDeepLink, "wa")}>
                  {copied === "wa" ? <Check size={14} /> : <Copy size={14} />} Copy link
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-text-muted">Enter a phone number including country code to generate a wa.me link and QR.</p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Cancel</Button>
            <Button onClick={() => saveConfig("whatsapp")}>Save &amp; activate</Button>
          </div>
        </div>
      </Modal>

      {/* Slack — OAuth URL + QR */}
      <Modal open={configuring === "slack"} onClose={() => setConfiguring(null)} title="Slack setup" wide>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Paste the Slack OAuth / app install URL from your AgentOS control plane. Scan the QR on your phone to open the same link (handy on desktop-first workspaces).
          </p>
          <Input
            label="Slack install URL"
            placeholder="https://slack.com/oauth/v2/authorize?..."
            value={slackInstallUrl}
            onChange={(e) => setSlackInstallUrl(e.target.value)}
          />
          {slackUrlTrimmed ? (
            <div className="flex flex-col sm:flex-row gap-6 items-start">
              <div className="rounded-lg border border-border p-2 bg-white shrink-0">
                <img src={qrCodeImageUrl(slackUrlTrimmed, 180)} width={180} height={180} className="rounded" alt="Slack OAuth QR" />
              </div>
              <div className="flex-1 space-y-2">
                <Button size="sm" variant="secondary" onClick={() => handleCopy(slackUrlTrimmed, "slack")}>
                  {copied === "slack" ? <Check size={14} /> : <Copy size={14} />} Copy install URL
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-text-muted">Add a URL to generate a QR code.</p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Close</Button>
            <Button onClick={() => saveConfig("slack")}>Mark configured</Button>
          </div>
        </div>
      </Modal>

      {/* Instagram config modal */}
      <Modal open={configuring === "instagram"} onClose={() => setConfiguring(null)} title="Instagram DMs Setup">
        <div className="space-y-4">
          <Input label="Instagram business account" placeholder="@yourbusiness" value={igAccount} onChange={(e) => setIgAccount(e.target.value)} />
          <p className="text-xs text-text-muted">Requires an Instagram Business or Creator account connected to a Facebook Page.</p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Cancel</Button>
            <Button onClick={() => saveConfig("instagram")}>
              <ExternalLink size={14} /> Connect Instagram
            </Button>
          </div>
        </div>
      </Modal>

      {/* Email config modal */}
      <Modal open={configuring === "email"} onClose={() => setConfiguring(null)} title="Email Channel Setup">
        <div className="space-y-4">
          <Input label="Support email address" placeholder="support@yourbusiness.com" value={emailAddress} onChange={(e) => setEmailAddress(e.target.value)} />
          <Select
            label="Email provider"
            value={emailProvider}
            onChange={(e) => setEmailProvider(e.target.value)}
            options={[
              { value: "gmail", label: "Gmail / Google Workspace" },
              { value: "outlook", label: "Outlook / Microsoft 365" },
              { value: "custom", label: "Custom IMAP/SMTP" },
            ]}
          />
          <p className="text-xs text-text-muted">Your agent will monitor this inbox and auto-respond to customer emails.</p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Cancel</Button>
            <Button onClick={() => saveConfig("email")}>Connect Email</Button>
          </div>
        </div>
      </Modal>

      {/* SMS / Messenger — generic setup */}
      <Modal open={configuring === "sms" || configuring === "messenger"} onClose={() => setConfiguring(null)} title={`${configuring === "sms" ? "SMS" : "Messenger"} Setup`}>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {configuring === "sms"
              ? "Connect via Twilio to send and receive SMS. Your Vapi phone number can also handle texts."
              : "Connect your Facebook Page to auto-respond on Messenger."}
          </p>
          <p className="text-xs text-text-muted">This integration will be available soon. Join the waitlist to be notified.</p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Close</Button>
            <Button onClick={() => { setConfiguring(null); toast("You're on the waitlist!"); }}>Join Waitlist</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
