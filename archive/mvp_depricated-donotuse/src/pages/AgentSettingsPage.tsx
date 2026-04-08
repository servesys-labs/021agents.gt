import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Check, RefreshCw, Loader2, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "../components/ui/Button";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";

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

// Real runtime tools — must match TOOL_CATALOG in the backend
const TOOLS = [
  { id: "web-search", label: "Web Search", desc: "Search the web via Brave" },
  { id: "browse", label: "Browse URL", desc: "Fetch and read web pages" },
  { id: "http-request", label: "HTTP Request", desc: "Make API calls" },
  { id: "web-crawl", label: "Web Crawl", desc: "Deep crawl websites" },
  { id: "python-exec", label: "Python", desc: "Execute Python code" },
  { id: "bash", label: "Bash", desc: "Run shell commands" },
  { id: "execute-code", label: "JavaScript", desc: "Run JS in sandbox" },
  { id: "read-file", label: "Read File", desc: "Read sandbox files" },
  { id: "write-file", label: "Write File", desc: "Write sandbox files" },
  { id: "edit-file", label: "Edit File", desc: "Edit files with diffs" },
  { id: "knowledge-search", label: "Knowledge Base", desc: "Search embedded knowledge" },
  { id: "store-knowledge", label: "Store Knowledge", desc: "Save to knowledge base" },
  { id: "image-generate", label: "Image Gen", desc: "Generate images with AI" },
  { id: "text-to-speech", label: "Text to Speech", desc: "Convert text to audio" },
  { id: "db-query", label: "Database Query", desc: "Query connected databases" },
  { id: "create-agent", label: "Create Agent", desc: "Spawn sub-agents" },
];

interface AgentDetail {
  name: string;
  description: string;
  config_json: Record<string, any>;
  is_active: boolean;
  version: number;
}

export default function AgentSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [description, setDescription] = useState("");
  const [persona, setPersona] = useState("");
  const [tone, setTone] = useState("friendly");
  const [responseLength, setResponseLength] = useState("medium");
  const [plan, setPlan] = useState<"free" | "basic" | "standard" | "premium">("standard");
  const [model, setModel] = useState("");
  const [budgetLimitUsd, setBudgetLimitUsd] = useState(10);
  const [maxTurns, setMaxTurns] = useState(50);
  const [reasoningStrategy, setReasoningStrategy] = useState("");
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
      setModel(cfg.model || "");
      setBudgetLimitUsd(Number(cfg.governance?.budget_limit_usd ?? cfg.budget_limit_usd ?? 10));
      setMaxTurns(Number(cfg.max_turns ?? 50));
      setReasoningStrategy(cfg.reasoning_strategy || "");
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
        system_prompt: persona,
        plan,
        model: model || undefined,
        tools,
        max_turns: maxTurns,
        budget_limit_usd: budgetLimitUsd,
        reasoning_strategy: reasoningStrategy || undefined,
        is_active: isLive,
        config_json: {
          ...(agent.config_json || {}),
          system_prompt: persona,
          model: model || undefined,
          plan,
          tone,
          response_length: responseLength,
          tools,
          max_turns: maxTurns,
          reasoning_strategy: reasoningStrategy || undefined,
          governance: { budget_limit_usd: budgetLimitUsd },
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

  return (
    <div>
      <AgentNav agentName={agent.name} />

      <div className="flex gap-8">
        {/* ── Left column: main form ── */}
        <div className="flex-1 min-w-0 space-y-5">
          {/* Essentials */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input label="Agent name" value={agent.name} disabled />
            <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          {/* Plan selector */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-text">LLM Plan</label>
            <p className="text-xs text-text-secondary mb-2">
              Controls which AI models power your agent. Higher tiers use more capable models.
            </p>
            <div className="grid grid-cols-4 gap-3">
              {([
                { key: "free" as const, label: "Free", desc: "Gemma 4 31B (self-hosted)", price: "Free" },
                { key: "basic" as const, label: "Basic", desc: "DeepSeek V3.2", price: "Near-free" },
                { key: "standard" as const, label: "Standard", desc: "Claude Sonnet 4.6", price: "Usage-based" },
                { key: "premium" as const, label: "Premium", desc: "Claude Opus 4.6", price: "Usage-based" },
              ]).map((p) => (
                <button
                  key={p.key}
                  onClick={() => setPlan(p.key)}
                  className={`p-3 rounded-lg border text-left transition-colors ${
                    plan === p.key
                      ? "border-primary bg-primary-light ring-1 ring-primary"
                      : "border-border hover:border-border"
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

          {/* Behavior */}
          <div className="space-y-4 border-t border-border pt-5">
            <h3 className="text-sm font-semibold text-text">Behavior</h3>
            <Textarea label="Persona / System prompt" value={persona} onChange={(e) => setPersona(e.target.value)} rows={5} />
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-text">Tone</label>
                <div className="flex gap-2">
                  {["friendly", "professional", "casual"].map((t) => (
                    <button
                      key={t}
                      onClick={() => setTone(t)}
                      className={`px-3 py-1.5 rounded-lg border text-sm font-medium capitalize transition-colors ${
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
                      className={`px-3 py-1.5 rounded-lg border text-sm font-medium capitalize transition-colors ${
                        responseLength === l ? "border-primary bg-primary-light text-primary" : "border-border text-text-secondary"
                      }`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Tools */}
          <div className="space-y-3 border-t border-border pt-5">
            <h3 className="text-sm font-semibold text-text">Tools</h3>
            <p className="text-xs text-text-secondary">
              Select which tools this agent can use.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {TOOLS.map((tool) => {
                const selected = tools.includes(tool.id);
                return (
                  <button
                    key={tool.id}
                    onClick={() => toggleTool(tool.id)}
                    className={`flex items-center gap-2 p-2.5 rounded-lg border text-left transition-colors ${
                      selected ? "border-primary bg-primary-light" : "border-border hover:border-border"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-text">{tool.label}</p>
                      <p className="text-[10px] text-text-muted truncate">{tool.desc}</p>
                    </div>
                    {selected && <Check size={14} className="text-primary shrink-0" />}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-text-muted">
              {tools.length} tools selected
            </p>
          </div>

          {/* ── Advanced toggle ── */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-sm font-medium text-text-secondary hover:text-text transition-colors"
          >
            {showAdvanced ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            {showAdvanced ? "Hide advanced settings" : "Show advanced settings"}
          </button>

          {showAdvanced && (
            <div className="space-y-5 border-t border-border pt-5">
              {/* Model & Limits */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-text">Model & Limits</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Input
                    label="Model override"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="Leave empty for plan default"
                  />
                  <Input
                    label="Budget limit (USD)"
                    type="number"
                    min={0}
                    max={10000}
                    step={0.5}
                    value={String(budgetLimitUsd)}
                    onChange={(e) => setBudgetLimitUsd(Number(e.target.value))}
                  />
                  <Input
                    label="Max turns"
                    type="number"
                    min={1}
                    max={1000}
                    value={String(maxTurns)}
                    onChange={(e) => setMaxTurns(Number(e.target.value))}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-text">Reasoning Strategy</label>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { key: "", label: "Auto" },
                      { key: "chain-of-thought", label: "Chain of Thought" },
                      { key: "plan-then-execute", label: "Plan Then Execute" },
                      { key: "step-back", label: "Step-Back" },
                      { key: "decompose", label: "Decompose" },
                      { key: "verify-then-respond", label: "Verify" },
                    ].map((s) => (
                      <button
                        key={s.key}
                        onClick={() => setReasoningStrategy(s.key)}
                        className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                          reasoningStrategy === s.key
                            ? "border-primary bg-primary-light text-primary"
                            : "border-border text-text-secondary hover:border-border"
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Live Handoff */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-text">Live Handoff</h3>
                <Card>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-text">Enable live handoff</p>
                      <p className="text-xs text-text-secondary mt-0.5">Escalate to a human when the agent can't help</p>
                    </div>
                    <button
                      onClick={() => setHandoffEnabled(!handoffEnabled)}
                      className={`relative w-11 h-6 rounded-full transition-colors ${handoffEnabled ? "bg-success" : "bg-surface-alt"}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-surface rounded-full shadow transition-transform ${handoffEnabled ? "translate-x-5" : ""}`} />
                    </button>
                  </div>
                </Card>

                {handoffEnabled && (
                  <>
                    <div className="space-y-1.5">
                      <label className="block text-sm font-medium text-text">Escalation triggers</label>
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
                                : "border-border text-text-secondary hover:border-border"
                            }`}
                          >
                            {trigger.replace(/_/g, " ")}
                          </button>
                        ))}
                      </div>
                    </div>
                    <Textarea label="Handoff message" value={handoffMessage} onChange={(e) => setHandoffMessage(e.target.value)} rows={2} />
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <Input label="Email" placeholder="support@yourbusiness.com" value={handoffEmail} onChange={(e) => setHandoffEmail(e.target.value)} />
                      <Input label="SMS / Phone" placeholder="+1 555 000 0000" value={handoffPhone} onChange={(e) => setHandoffPhone(e.target.value)} />
                      <Input label="Slack channel" placeholder="#support-alerts" value={handoffSlack} onChange={(e) => setHandoffSlack(e.target.value)} />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Save */}
          <div className="pt-2">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <><Loader2 size={14} className="animate-spin" /> Saving...</> : "Save Changes"}
            </Button>
          </div>
        </div>

        {/* ── Right column: status & deployment sidebar ── */}
        <div className="hidden lg:block w-72 shrink-0 space-y-4">
          {/* Status */}
          <Card>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-text">Status</p>
              <button
                onClick={() => setIsLive(!isLive)}
                className={`relative w-11 h-6 rounded-full transition-colors ${isLive ? "bg-success" : "bg-surface-alt"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-surface rounded-full shadow transition-transform ${isLive ? "translate-x-5" : ""}`} />
              </button>
            </div>
            <p className="text-xs text-text-secondary">
              {isLive ? "Agent is live and handling conversations" : "Agent is in draft mode — not visible to customers"}
            </p>
            <div className="mt-3 pt-3 border-t border-border space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-text-muted">Version</span>
                <span className="font-medium text-text">v{agent.version}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Plan</span>
                <span className="font-medium text-text capitalize">{plan}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Tools</span>
                <span className="font-medium text-text">{tools.length} active</span>
              </div>
            </div>
          </Card>

          {/* Deployment */}
          <Card>
            <p className="text-sm font-semibold text-text mb-3">Deployment</p>
            <div className="space-y-3">
              <div>
                <p className="text-xs text-text-muted mb-1">Widget embed</p>
                <code className="block bg-surface-alt rounded-lg p-2 text-[10px] text-text-secondary break-all leading-relaxed">
                  {`<script src="https://oneshots.co/widget/${id}.js"></script>`}
                </code>
              </div>
              <div>
                <p className="text-xs text-text-muted mb-1">API endpoint</p>
                <Badge variant="info">{`POST /api/v1/agents/${id}/chat`}</Badge>
              </div>
            </div>
          </Card>

          {/* Danger zone */}
          <Card className="border-danger bg-danger-light/40">
            <p className="text-sm font-medium text-text">Remove assistant</p>
            <p className="text-xs text-text-secondary mt-1 leading-relaxed">
              Deactivates the agent. Data retained per plan.
            </p>
            <Button
              type="button"
              variant="danger"
              size="sm"
              className="mt-3 w-full"
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting ? (
                <><Loader2 size={14} className="animate-spin" /> Removing…</>
              ) : (
                <><Trash2 size={14} /> Remove assistant</>
              )}
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
}
