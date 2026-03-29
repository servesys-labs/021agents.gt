import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Check, RefreshCw, Loader2, Trash2 } from "lucide-react";
import { Button } from "../components/ui/Button";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { TabNav } from "../components/ui/TabNav";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { agentPathSegment } from "../lib/agent-path";
import { Mail, Calendar, CreditCard, MessageSquare, Table, Users, Phone, Camera } from "lucide-react";

const iconMap: Record<string, React.ComponentType<any>> = {
  Mail, Calendar, CreditCard, MessageSquare, Table, Users, Phone, Camera,
};

const TOOLS = [
  { id: "email", label: "Email", icon: "Mail" },
  { id: "calendar", label: "Calendar", icon: "Calendar" },
  { id: "stripe", label: "Stripe", icon: "CreditCard" },
  { id: "slack", label: "Slack", icon: "MessageSquare" },
  { id: "sheets", label: "Google Sheets", icon: "Table" },
  { id: "crm", label: "CRM", icon: "Users" },
  { id: "whatsapp", label: "WhatsApp", icon: "Phone" },
  { id: "instagram", label: "Instagram", icon: "Camera" },
];

interface AgentDetail {
  name: string;
  description: string;
  config_json: Record<string, any>;
  is_active: boolean;
  version: number;
}

type Tab = "general" | "behavior" | "tools" | "handoff" | "deploy";

export default function AgentSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("general");
  const [description, setDescription] = useState("");
  const [persona, setPersona] = useState("");
  const [tone, setTone] = useState("friendly");
  const [responseLength, setResponseLength] = useState("medium");
  const [plan, setPlan] = useState<"basic" | "standard" | "premium">("standard");
  const [tools, setTools] = useState<string[]>([]);
  const [isLive, setIsLive] = useState(false);

  // Handoff settings
  const [handoffEnabled, setHandoffEnabled] = useState(true);
  const [handoffEmail, setHandoffEmail] = useState("");
  const [handoffPhone, setHandoffPhone] = useState("");
  const [handoffSlack, setHandoffSlack] = useState("");
  const [handoffTriggers, setHandoffTriggers] = useState<string[]>([]);
  const [handoffMessage, setHandoffMessage] = useState("I'm going to connect you with our team who can help you directly. One moment please!");
  const [deleting, setDeleting] = useState(false);

  const fetchAgent = async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const seg = agentPathSegment(id);
    try {
      const data = await api.get<AgentDetail>(`/agents/${seg}`);
      setAgent(data);
      // Populate form from config_json
      const cfg = data.config_json || {};
      setDescription(data.description || "");
      setPersona(cfg.system_prompt || cfg.persona || "");
      setTone(cfg.tone || "friendly");
      setResponseLength(cfg.response_length || "medium");
      setPlan(cfg.plan || "standard");
      setTools(cfg.tools || []);
      setIsLive(data.is_active ?? false);
      // Handoff
      const handoff = cfg.handoff || {};
      setHandoffEnabled(handoff.enabled ?? false);
      setHandoffEmail(handoff.email || "");
      setHandoffPhone(handoff.phone || "");
      setHandoffSlack(handoff.slack || "");
      setHandoffTriggers(handoff.triggers || []);
      if (handoff.message) setHandoffMessage(handoff.message);
    } catch (err: any) {
      if (err.status === 404) {
        setAgent(null);
      } else {
        setError(err.message || "Failed to load agent");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) fetchAgent();
  }, [id]);

  const toggleTool = (toolId: string) =>
    setTools((prev) => (prev.includes(toolId) ? prev.filter((t) => t !== toolId) : [...prev, toolId]));

  const handleSave = async () => {
    if (!agent || !id) return;
    setSaving(true);
    try {
      await api.put(`/agents/${agentPathSegment(id)}`, {
        description,
        is_active: isLive,
        config_json: {
          ...(agent.config_json || {}),
          system_prompt: persona,
          plan,
          tone,
          response_length: responseLength,
          tools,
          handoff: {
            enabled: handoffEnabled,
            email: handoffEmail,
            phone: handoffPhone,
            slack: handoffSlack,
            triggers: handoffTriggers,
            message: handoffMessage,
          },
        },
      });
      toast("Settings saved");
    } catch (err: any) {
      toast(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!agent || !id) return;
    if (!window.confirm(`Remove “${agent.name}” from your workspace? It will no longer appear in your list.`)) return;
    setDeleting(true);
    try {
      await api.del(`/agents/${agentPathSegment(id)}`);
      toast("Assistant removed");
      navigate("/");
    } catch (err: any) {
      toast(err.message || "Could not remove assistant");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-text-secondary text-sm mb-4">{error}</p>
        <Button variant="secondary" onClick={fetchAgent}>
          <RefreshCw size={14} /> Retry
        </Button>
      </div>
    );
  }

  if (!agent) return <AgentNotFound />;

  const tabs: { key: Tab; label: string }[] = [
    { key: "general", label: "General" },
    { key: "behavior", label: "Behavior" },
    { key: "tools", label: "Tools" },
    { key: "handoff", label: "Live Handoff" },
    { key: "deploy", label: "Deployment" },
  ];

  return (
    <div>
      <AgentNav agentName={agent.name} />

      <TabNav tabs={tabs} active={tab} onChange={(k) => setTab(k as Tab)} />

      {tab === "general" && (
        <div className="space-y-4 max-w-lg">
          <Input label="Agent name" value={agent.name} disabled />
          <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-text">LLM Plan</label>
            <p className="text-xs text-text-secondary mb-2">
              Controls which AI models power your agent. Higher tiers use more capable models.
            </p>
            <div className="grid grid-cols-3 gap-3">
              {([
                { key: "basic" as const, label: "Basic", desc: "Free-tier models (Workers AI)", price: "Free" },
                { key: "standard" as const, label: "Standard", desc: "GPT, Claude & Gemini mix", price: "Usage-based" },
                { key: "premium" as const, label: "Premium", desc: "Top-tier models (Opus, GPT-5)", price: "Usage-based" },
              ]).map((p) => (
                <button
                  key={p.key}
                  onClick={() => setPlan(p.key)}
                  className={`p-3 rounded-lg border text-left transition-colors ${
                    plan === p.key
                      ? "border-primary bg-primary-light ring-1 ring-primary"
                      : "border-border hover:border-gray-300"
                  }`}
                >
                  <p className="text-sm font-semibold text-text">{p.label}</p>
                  <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">{p.desc}</p>
                  <Badge variant={plan === p.key ? "success" : "default"} className="mt-2 text-[10px]">
                    {p.price}
                  </Badge>
                </button>
              ))}
            </div>
          </div>

          <Card className="border-red-200 bg-red-50/40">
            <p className="text-sm font-medium text-text">Remove assistant</p>
            <p className="text-xs text-text-secondary mt-1 leading-relaxed">
              This deactivates the agent for your organization. Data may be retained per your plan; contact support for a full data purge if needed.
            </p>
            <Button
              type="button"
              variant="danger"
              size="sm"
              className="mt-3"
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Removing…
                </>
              ) : (
                <>
                  <Trash2 size={14} /> Remove assistant
                </>
              )}
            </Button>
          </Card>
        </div>
      )}

      {tab === "behavior" && (
        <div className="space-y-4 max-w-lg">
          <Textarea label="Persona / System prompt" value={persona} onChange={(e) => setPersona(e.target.value)} rows={6} />
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-text">Tone</label>
            <div className="flex gap-2">
              {["friendly", "professional", "casual"].map((t) => (
                <button
                  key={t}
                  onClick={() => setTone(t)}
                  className={`px-4 py-2 rounded-lg border text-sm font-medium capitalize transition-colors ${
                    tone === t ? "border-primary bg-primary-light text-primary" : "border-border text-text-secondary"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-text">Response length</label>
            <div className="flex gap-2">
              {["short", "medium", "detailed"].map((l) => (
                <button
                  key={l}
                  onClick={() => setResponseLength(l)}
                  className={`px-4 py-2 rounded-lg border text-sm font-medium capitalize transition-colors ${
                    responseLength === l ? "border-primary bg-primary-light text-primary" : "border-border text-text-secondary"
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "tools" && (
        <div className="grid grid-cols-2 gap-3 max-w-lg">
          {TOOLS.map((tool) => {
            const Icon = iconMap[tool.icon];
            const selected = tools.includes(tool.id);
            return (
              <button
                key={tool.id}
                onClick={() => toggleTool(tool.id)}
                className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                  selected ? "border-primary bg-primary-light" : "border-border hover:border-gray-300"
                }`}
              >
                {Icon && <Icon size={18} />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text">{tool.label}</p>
                </div>
                {selected && <Check size={16} className="text-primary shrink-0" />}
              </button>
            );
          })}
        </div>
      )}

      {tab === "handoff" && (
        <div className="space-y-4 max-w-lg">
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text">Enable live handoff</p>
                <p className="text-xs text-text-secondary mt-0.5">
                  When the agent can't handle a request, escalate to a human
                </p>
              </div>
              <button
                onClick={() => setHandoffEnabled(!handoffEnabled)}
                className={`relative w-11 h-6 rounded-full transition-colors ${handoffEnabled ? "bg-success" : "bg-gray-200"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${handoffEnabled ? "translate-x-5" : ""}`} />
              </button>
            </div>
          </Card>

          {handoffEnabled && (
            <>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-text">Escalation triggers</label>
                <p className="text-xs text-text-muted mb-2">When should the agent hand off to a human?</p>
                <div className="flex flex-wrap gap-2">
                  {["angry_customer", "refund_request", "complex_order", "billing_issue", "technical_problem", "custom_request"].map((trigger) => (
                    <button
                      key={trigger}
                      onClick={() =>
                        setHandoffTriggers((prev) =>
                          prev.includes(trigger) ? prev.filter((t) => t !== trigger) : [...prev, trigger],
                        )
                      }
                      className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                        handoffTriggers.includes(trigger)
                          ? "border-primary bg-primary-light text-primary"
                          : "border-border text-text-secondary hover:border-gray-300"
                      }`}
                    >
                      {trigger.replace(/_/g, " ")}
                    </button>
                  ))}
                </div>
              </div>

              <Textarea
                label="Handoff message"
                value={handoffMessage}
                onChange={(e) => setHandoffMessage(e.target.value)}
                rows={3}
              />

              <p className="text-xs font-medium text-text mt-4 mb-2">Notify via</p>
              <Input label="Email" placeholder="support@yourbusiness.com" value={handoffEmail} onChange={(e) => setHandoffEmail(e.target.value)} />
              <Input label="SMS / Phone" placeholder="+1 555 000 0000" value={handoffPhone} onChange={(e) => setHandoffPhone(e.target.value)} />
              <Input label="Slack channel" placeholder="#support-alerts" value={handoffSlack} onChange={(e) => setHandoffSlack(e.target.value)} />

              <div className="bg-blue-50 rounded-lg p-3 text-xs text-blue-700">
                When triggered, the agent will send the handoff message to the customer and notify you via your preferred channels with the conversation context.
              </div>
            </>
          )}
        </div>
      )}

      {tab === "deploy" && (
        <div className="space-y-4 max-w-lg">
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text">Status</p>
                <p className="text-xs text-text-secondary mt-0.5">
                  {isLive ? "Agent is live and handling conversations" : "Agent is in draft mode"}
                </p>
              </div>
              <button
                onClick={() => setIsLive(!isLive)}
                className={`relative w-11 h-6 rounded-full transition-colors ${isLive ? "bg-success" : "bg-gray-200"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${isLive ? "translate-x-5" : ""}`} />
              </button>
            </div>
          </Card>
          <Card>
            <p className="text-sm font-medium text-text mb-2">Widget embed code</p>
            <code className="block bg-surface-alt rounded-lg p-3 text-xs text-text-secondary break-all">
              {`<script src="https://agentos.dev/widget/${id}.js"></script>`}
            </code>
          </Card>
          <Card>
            <p className="text-sm font-medium text-text mb-1">API endpoint</p>
            <Badge variant="info">{`POST /api/v1/agents/${id}/chat`}</Badge>
          </Card>
        </div>
      )}

      <div className="mt-8">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? <><Loader2 size={14} className="animate-spin" /> Saving...</> : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
