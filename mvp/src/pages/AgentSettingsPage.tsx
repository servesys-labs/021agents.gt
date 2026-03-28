import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Check } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { useToast } from "../components/ui/Toast";
import { MOCK_AGENTS, TOOLS } from "../lib/mock-data";
import { Mail, Calendar, CreditCard, MessageSquare, Table, Users, Phone, Camera } from "lucide-react";

const iconMap: Record<string, React.ComponentType<any>> = {
  Mail, Calendar, CreditCard, MessageSquare, Table, Users, Phone, Camera,
};

type Tab = "general" | "behavior" | "tools" | "deploy";

export default function AgentSettingsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const agent = MOCK_AGENTS.find((a) => a.id === id);

  const [tab, setTab] = useState<Tab>("general");
  const [name, setName] = useState(agent?.name || "");
  const [description, setDescription] = useState(agent?.description || "");
  const [persona, setPersona] = useState(agent?.persona || "");
  const [tone, setTone] = useState(agent?.tone || "friendly");
  const [responseLength, setResponseLength] = useState(agent?.response_length || "medium");
  const [tools, setTools] = useState<string[]>(agent?.tools || []);
  const [isLive, setIsLive] = useState(agent?.status === "active");

  const toggleTool = (toolId: string) =>
    setTools((prev) => (prev.includes(toolId) ? prev.filter((t) => t !== toolId) : [...prev, toolId]));

  const handleSave = () => {
    // TODO: PUT to /api/v1/agents/:id
    toast("Settings saved");
  };

  if (!agent) {
    return <p className="text-text-secondary">Agent not found. <Link to="/" className="text-primary">Go back</Link></p>;
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "general", label: "General" },
    { key: "behavior", label: "Behavior" },
    { key: "tools", label: "Tools" },
    { key: "deploy", label: "Deployment" },
  ];

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(-1)} className="p-1.5 rounded-lg hover:bg-surface-alt text-text-secondary">
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-xl font-semibold text-text">{agent.name} — Settings</h1>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border mb-6">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key ? "border-primary text-primary" : "border-transparent text-text-secondary hover:text-text"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "general" && (
        <div className="space-y-4 max-w-lg">
          <Input label="Agent name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
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
              {`<script src="https://agentos.dev/widget/${agent.id}.js"></script>`}
            </code>
          </Card>
          <Card>
            <p className="text-sm font-medium text-text mb-1">API endpoint</p>
            <Badge variant="info">{`POST /api/v1/agents/${agent.id}/chat`}</Badge>
          </Card>
        </div>
      )}

      <div className="mt-8">
        <Button onClick={handleSave}>Save Changes</Button>
      </div>
    </div>
  );
}
