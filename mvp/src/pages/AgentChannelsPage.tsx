import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Globe, MessageSquare, Instagram, Phone, Mail, MessageCircle, Copy, Check, ExternalLink, Code } from "lucide-react";
import { Button } from "../components/ui/Button";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { MOCK_AGENTS } from "../lib/mock-data";

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
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const agent = MOCK_AGENTS.find((a) => a.id === id);

  const [channels, setChannels] = useState<Channel[]>([
    {
      id: "web_widget", name: "Web Widget", icon: <Globe size={20} className="text-blue-500" />,
      description: "Embed a chat widget on your website", status: "active",
      config: { position: "bottom-right", color: "#2563eb" },
      stats: { conversations: 32, messages: 156 },
    },
    {
      id: "whatsapp", name: "WhatsApp Business", icon: <MessageCircle size={20} className="text-green-500" />,
      description: "Respond to customers on WhatsApp", status: "active",
      config: { phone: "+1 (555) 012-3456" },
      stats: { conversations: 18, messages: 89 },
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
      description: "Connect to your Facebook page's Messenger", status: "inactive",
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

  // Instagram config
  const [igAccount, setIgAccount] = useState("");

  // Email config
  const [emailAddress, setEmailAddress] = useState("");
  const [emailProvider, setEmailProvider] = useState("gmail");

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

  if (!agent) return <AgentNotFound />;

  const widgetSnippet = `<script src="https://agentos.dev/widget/${agent.id}.js"
  data-position="${widgetPosition}"
  data-color="${widgetColor}"
  data-greeting="${widgetGreeting}">
</script>`;

  const apiEndpoint = `POST https://api.agentos.dev/v1/agents/${agent.id}/chat
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json

{"message": "Hello", "session_id": "optional"}`;

  return (
    <div>
      <AgentNav agentName={agent.name} />

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

      {/* WhatsApp config modal */}
      <Modal open={configuring === "whatsapp"} onClose={() => setConfiguring(null)} title="WhatsApp Business Setup">
        <div className="space-y-4">
          <Input label="WhatsApp Business phone" placeholder="+1 555 000 0000" value={waPhone} onChange={(e) => setWaPhone(e.target.value)} />
          <Input label="WhatsApp Business API key" type="password" placeholder="Your API key" value={waApiKey} onChange={(e) => setWaApiKey(e.target.value)} />
          <p className="text-xs text-text-muted">Connect via the WhatsApp Business API. You'll need a verified business account.</p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfiguring(null)}>Cancel</Button>
            <Button onClick={() => saveConfig("whatsapp")}>Connect WhatsApp</Button>
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
