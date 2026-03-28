import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Phone, PhoneCall, PhoneOff, PhoneMissed, Settings, Volume2, Clock, Copy, Check, Plus } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Textarea } from "../components/ui/Textarea";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { MOCK_AGENTS } from "../lib/mock-data";

interface PhoneNumber {
  id: string;
  number: string;
  label: string;
  provider: "vapi";
  status: "active" | "inactive";
  assigned_at: string;
}

interface CallLog {
  id: string;
  caller: string;
  duration_seconds: number;
  status: "completed" | "missed" | "voicemail";
  started_at: string;
  summary?: string;
}

const MOCK_NUMBERS: PhoneNumber[] = [
  { id: "ph-1", number: "+1 (555) 012-3456", label: "Main line", provider: "vapi", status: "active", assigned_at: "2026-03-25T10:00:00Z" },
];

const MOCK_CALLS: CallLog[] = [
  { id: "call-1", caller: "+1 (555) 987-6543", duration_seconds: 185, status: "completed", started_at: "2026-03-28T09:15:00Z", summary: "Customer asked about delivery to West Side. Agent confirmed delivery area and scheduled for Thursday." },
  { id: "call-2", caller: "+1 (555) 111-2222", duration_seconds: 72, status: "completed", started_at: "2026-03-28T09:42:00Z", summary: "Price inquiry for sympathy arrangement. Agent quoted $55-85 range and offered same-day delivery." },
  { id: "call-3", caller: "+1 (555) 333-4444", duration_seconds: 0, status: "missed", started_at: "2026-03-28T10:05:00Z" },
  { id: "call-4", caller: "+1 (555) 555-6666", duration_seconds: 310, status: "completed", started_at: "2026-03-28T10:30:00Z", summary: "Wedding consultation request. Agent collected date (June 14), venue (The Grand Ballroom), budget ($2,000). Booked a 30-min consultation for Friday." },
  { id: "call-5", caller: "+1 (555) 777-8888", duration_seconds: 45, status: "voicemail", started_at: "2026-03-28T11:00:00Z", summary: "Caller left voicemail asking about store hours." },
];

const VOICES = [
  { value: "alloy", label: "Alloy — Warm & friendly" },
  { value: "echo", label: "Echo — Clear & professional" },
  { value: "nova", label: "Nova — Bright & energetic" },
  { value: "onyx", label: "Onyx — Deep & authoritative" },
  { value: "shimmer", label: "Shimmer — Soft & approachable" },
];

const callStatusConfig = {
  completed: { icon: PhoneCall, variant: "success" as const, label: "Completed" },
  missed: { icon: PhoneMissed, variant: "danger" as const, label: "Missed" },
  voicemail: { icon: Volume2, variant: "warning" as const, label: "Voicemail" },
};

function formatDuration(seconds: number): string {
  if (seconds === 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function AgentVoicePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const agent = MOCK_AGENTS.find((a) => a.id === id);

  const [numbers, setNumbers] = useState<PhoneNumber[]>(MOCK_NUMBERS);
  const [calls] = useState<CallLog[]>(MOCK_CALLS);
  const [showSetup, setShowSetup] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedCall, setSelectedCall] = useState<CallLog | null>(null);
  const [copied, setCopied] = useState(false);

  // Voice settings
  const [voice, setVoice] = useState("alloy");
  const [greeting, setGreeting] = useState(
    "Hi, thanks for calling Sarah's Flower Shop! I'm an AI assistant and I can help you with orders, delivery questions, or booking a consultation. How can I help you today?",
  );
  const [language, setLanguage] = useState("en");
  const [maxDuration, setMaxDuration] = useState("600");
  const [vapiKey, setVapiKey] = useState("");

  // Setup form
  const [setupStep, setSetupStep] = useState<"key" | "number">("key");
  const [newNumber, setNewNumber] = useState("");
  const [newLabel, setNewLabel] = useState("Main line");

  const handleConnect = () => {
    if (!vapiKey.trim()) return;
    setSetupStep("number");
  };

  const handleAssignNumber = () => {
    if (!newNumber.trim()) return;
    const phone: PhoneNumber = {
      id: `ph-${Date.now()}`,
      number: newNumber.trim(),
      label: newLabel.trim() || "Phone line",
      provider: "vapi",
      status: "active",
      assigned_at: new Date().toISOString(),
    };
    setNumbers((prev) => [...prev, phone]);
    setShowSetup(false);
    setSetupStep("key");
    setNewNumber("");
    toast("Phone number assigned! Your agent can now take calls.");
  };

  const toggleNumber = (numId: string) => {
    setNumbers((prev) =>
      prev.map((n) =>
        n.id === numId ? { ...n, status: n.status === "active" ? "inactive" : "active" } : n,
      ),
    );
  };

  const removeNumber = (numId: string) => {
    setNumbers((prev) => prev.filter((n) => n.id !== numId));
    toast("Phone number removed");
  };

  const copyNumber = (number: string) => {
    navigator.clipboard.writeText(number.replace(/[^+\d]/g, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!agent) {
    return <p className="text-text-secondary">Agent not found. <Link to="/" className="text-primary">Go back</Link></p>;
  }

  const activeNumbers = numbers.filter((n) => n.status === "active");
  const completedCalls = calls.filter((c) => c.status === "completed");
  const totalMinutes = Math.round(calls.reduce((s, c) => s + c.duration_seconds, 0) / 60);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(-1)} className="p-1.5 rounded-lg hover:bg-surface-alt text-text-secondary">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-text">{agent.name} — Voice & Phone</h1>
          <p className="text-sm text-text-secondary">Let customers call your agent directly via Vapi</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setShowSettings(true)}>
          <Settings size={14} /> Voice Settings
        </Button>
        <Button size="sm" onClick={() => setShowSetup(true)}>
          <Plus size={14} /> Add Number
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <Phone size={14} className="text-primary" />
            <span className="text-xs text-text-secondary">Active Numbers</span>
          </div>
          <p className="text-xl font-semibold text-text">{activeNumbers.length}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <PhoneCall size={14} className="text-success" />
            <span className="text-xs text-text-secondary">Calls Today</span>
          </div>
          <p className="text-xl font-semibold text-text">{calls.length}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <Check size={14} className="text-primary" />
            <span className="text-xs text-text-secondary">Completed</span>
          </div>
          <p className="text-xl font-semibold text-text">{completedCalls.length}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <Clock size={14} className="text-warning" />
            <span className="text-xs text-text-secondary">Total Minutes</span>
          </div>
          <p className="text-xl font-semibold text-text">{totalMinutes}</p>
        </Card>
      </div>

      {/* Phone numbers */}
      <h2 className="text-lg font-medium text-text mb-3">Phone Numbers</h2>
      {numbers.length === 0 ? (
        <Card className="mb-8">
          <div className="text-center py-8">
            <Phone size={36} className="mx-auto text-text-muted mb-3" />
            <p className="text-sm font-medium text-text mb-1">No phone numbers assigned</p>
            <p className="text-xs text-text-muted mb-4">Connect your Vapi account and assign a phone number so customers can call your agent.</p>
            <Button size="sm" onClick={() => setShowSetup(true)}>
              <Plus size={14} /> Set up Voice
            </Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-3 mb-8">
          {numbers.map((num) => (
            <Card key={num.id}>
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center">
                  <Phone size={20} className="text-success" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-text">{num.number}</span>
                    <button onClick={() => copyNumber(num.number)} className="p-0.5 text-text-muted hover:text-text">
                      {copied ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  </div>
                  <p className="text-xs text-text-muted">{num.label} · via {num.provider.toUpperCase()}</p>
                </div>
                <Badge variant={num.status === "active" ? "success" : "default"}>{num.status}</Badge>
                <div className="flex gap-2">
                  <button
                    onClick={() => toggleNumber(num.id)}
                    className={`relative w-10 h-6 rounded-full transition-colors ${num.status === "active" ? "bg-success" : "bg-gray-200"}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${num.status === "active" ? "translate-x-4" : ""}`} />
                  </button>
                  <Button size="sm" variant="ghost" onClick={() => removeNumber(num.id)}>
                    <PhoneOff size={14} />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Call logs */}
      <h2 className="text-lg font-medium text-text mb-3">Recent Calls</h2>
      <div className="bg-white rounded-xl border border-border divide-y divide-border">
        {calls.length === 0 && (
          <p className="p-6 text-sm text-text-muted text-center">No calls yet</p>
        )}
        {calls.map((call) => {
          const status = callStatusConfig[call.status];
          const StatusIcon = status.icon;
          return (
            <button
              key={call.id}
              onClick={() => setSelectedCall(call)}
              className="w-full flex items-center gap-4 p-4 hover:bg-surface-alt transition-colors text-left"
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                call.status === "completed" ? "bg-emerald-50" : call.status === "missed" ? "bg-red-50" : "bg-amber-50"
              }`}>
                <StatusIcon size={16} className={
                  call.status === "completed" ? "text-success" : call.status === "missed" ? "text-danger" : "text-warning"
                } />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text">{call.caller}</span>
                  <Badge variant={status.variant}>{status.label}</Badge>
                </div>
                {call.summary && (
                  <p className="text-xs text-text-muted mt-0.5 truncate">{call.summary}</p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs text-text-muted">{formatDuration(call.duration_seconds)}</p>
                <p className="text-xs text-text-muted">
                  {new Date(call.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Call detail modal */}
      <Modal open={!!selectedCall} onClose={() => setSelectedCall(null)} title="Call Details" wide>
        {selectedCall && (() => {
          const status = callStatusConfig[selectedCall.status];
          return (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Phone size={20} className="text-text-secondary" />
                <span className="text-lg font-medium text-text">{selectedCall.caller}</span>
                <Badge variant={status.variant}>{status.label}</Badge>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-text-secondary text-xs">Duration</dt>
                  <dd className="font-medium text-text">{formatDuration(selectedCall.duration_seconds)}</dd>
                </div>
                <div>
                  <dt className="text-text-secondary text-xs">Time</dt>
                  <dd className="font-medium text-text">{new Date(selectedCall.started_at).toLocaleString()}</dd>
                </div>
              </dl>
              {selectedCall.summary && (
                <div>
                  <p className="text-xs font-medium text-text-secondary mb-1">Call Summary</p>
                  <div className="bg-surface-alt rounded-lg p-4 text-sm text-text leading-relaxed">
                    {selectedCall.summary}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </Modal>

      {/* Setup modal */}
      <Modal open={showSetup} onClose={() => { setShowSetup(false); setSetupStep("key"); }} title="Set up Voice Agent">
        {setupStep === "key" && (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary">
              Connect your <a href="https://vapi.ai" target="_blank" rel="noopener" className="text-primary hover:underline">Vapi</a> account to enable phone calls for your agent.
            </p>
            <Input
              label="Vapi API Key"
              type="password"
              placeholder="vapi_sk_..."
              value={vapiKey}
              onChange={(e) => setVapiKey(e.target.value)}
            />
            <div className="bg-surface-alt rounded-lg p-3 text-xs text-text-secondary">
              Find your API key at <span className="font-mono text-text">dashboard.vapi.ai/keys</span>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setShowSetup(false)}>Cancel</Button>
              <Button onClick={handleConnect} disabled={!vapiKey.trim()}>Connect</Button>
            </div>
          </div>
        )}
        {setupStep === "number" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 px-3 py-2 bg-emerald-50 text-emerald-700 text-xs rounded-lg">
              <Check size={14} />
              Vapi connected successfully
            </div>
            <Input
              label="Phone number"
              placeholder="+1 (555) 000-0000"
              value={newNumber}
              onChange={(e) => setNewNumber(e.target.value)}
            />
            <Input
              label="Label"
              placeholder="e.g. Main line, Support line"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
            <p className="text-xs text-text-muted">
              You can purchase numbers directly from your Vapi dashboard, or port an existing number.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setSetupStep("key")}>Back</Button>
              <Button onClick={handleAssignNumber} disabled={!newNumber.trim()}>Assign Number</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Voice settings modal */}
      <Modal open={showSettings} onClose={() => setShowSettings(false)} title="Voice Settings">
        <div className="space-y-4">
          <Select
            label="Voice"
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            options={VOICES}
          />
          <Textarea
            label="Greeting message"
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            rows={4}
          />
          <Select
            label="Language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            options={[
              { value: "en", label: "English" },
              { value: "es", label: "Spanish" },
              { value: "fr", label: "French" },
              { value: "de", label: "German" },
              { value: "pt", label: "Portuguese" },
              { value: "ja", label: "Japanese" },
              { value: "zh", label: "Chinese (Mandarin)" },
            ]}
          />
          <Select
            label="Max call duration"
            value={maxDuration}
            onChange={(e) => setMaxDuration(e.target.value)}
            options={[
              { value: "300", label: "5 minutes" },
              { value: "600", label: "10 minutes" },
              { value: "900", label: "15 minutes" },
              { value: "1800", label: "30 minutes" },
            ]}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setShowSettings(false)}>Cancel</Button>
            <Button onClick={() => { setShowSettings(false); toast("Voice settings saved"); }}>Save</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
