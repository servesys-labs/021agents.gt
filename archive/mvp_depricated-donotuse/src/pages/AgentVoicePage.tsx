import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Phone, PhoneCall, PhoneOff, PhoneMissed, Settings, Volume2, Clock, Copy, Check, Plus, Loader2, Search, ShoppingCart, ArrowRight } from "lucide-react";
import { Button } from "../components/ui/Button";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Textarea } from "../components/ui/Textarea";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { agentPathSegment } from "../lib/agent-path";
import { ensureArray } from "../lib/ensure-array";

interface VoiceConfigResponse {
  voice?: string;
  greeting?: string;
  language?: string;
  max_duration?: number;
  vapi_configured?: boolean;
  vapi_assistant_id?: string;
  vapi_phone_number_id?: string;
  calls?: CallLog[];
}

interface TwilioNumber {
  id: string;
  phone_number: string;
  agent_name: string;
  provider: string;
  provider_sid: string;
  status: string;
  created_at: string;
}

interface AvailableNumber {
  phone_number: string;
  friendly_name: string;
  locality: string;
  region: string;
  postal_code: string;
  capabilities: Record<string, boolean>;
}

interface CallLog {
  id: string;
  caller: string;
  duration_seconds: number;
  status: "completed" | "missed" | "voicemail";
  started_at: string;
  summary?: string;
}

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

function formatPhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

export default function AgentVoicePage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();

  // Page state
  const [agentName, setAgentName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Twilio numbers
  const [twilioNumbers, setTwilioNumbers] = useState<TwilioNumber[]>([]);
  const [twilioConfigured, setTwilioConfigured] = useState(false);

  // Number search state
  const [searchAreaCode, setSearchAreaCode] = useState("");
  const [searching, setSearching] = useState(false);
  const [availableNumbers, setAvailableNumbers] = useState<AvailableNumber[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  // Buy confirmation
  const [buyingNumber, setBuyingNumber] = useState<AvailableNumber | null>(null);
  const [purchasing, setPurchasing] = useState(false);

  // Test call
  const [showTestCall, setShowTestCall] = useState(false);
  const [testCallTo, setTestCallTo] = useState("");
  const [testCallFrom, setTestCallFrom] = useState("");
  const [placingTestCall, setPlacingTestCall] = useState(false);

  // Voice settings
  const [showSettings, setShowSettings] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [voice, setVoice] = useState("alloy");
  const [greeting, setGreeting] = useState("");
  const [language, setLanguage] = useState("en");
  const [maxDuration, setMaxDuration] = useState("600");

  // Calls
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [selectedCall, setSelectedCall] = useState<CallLog | null>(null);

  // Misc
  const [copied, setCopied] = useState(false);

  const loadVoicePage = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const seg = agentPathSegment(id);
    try {
      const agent = await api.get<{ name: string }>(`/agents/${seg}`);
      const name = agent.name ?? id;
      setAgentName(name);

      // Load voice config
      const config = await api.get<VoiceConfigResponse>(
        `/voice/config?agent_name=${encodeURIComponent(name)}`,
      );
      if (config.voice) setVoice(config.voice);
      if (config.greeting) setGreeting(config.greeting);
      if (config.language) setLanguage(config.language);
      if (config.max_duration != null) setMaxDuration(String(config.max_duration));
      setCalls(ensureArray<CallLog>(config.calls));

      // Load Twilio integration status + numbers
      try {
        const status = await api.get<{ configured: boolean }>("/voice/twilio/integration-status");
        setTwilioConfigured(status.configured);
      } catch {
        setTwilioConfigured(false);
      }

      try {
        const numResp = await api.get<{ numbers: TwilioNumber[] }>(
          `/voice/twilio/numbers?agent_name=${encodeURIComponent(name)}`,
        );
        setTwilioNumbers(ensureArray<TwilioNumber>(numResp.numbers));
      } catch {
        setTwilioNumbers([]);
      }
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status === 404) setAgentName(null);
      else setError(e.message || "Failed to load voice settings");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadVoicePage();
  }, [loadVoicePage]);

  // ── Search available numbers ──
  const searchNumbers = async () => {
    setSearching(true);
    setHasSearched(true);
    try {
      const params = new URLSearchParams({ country: "US", limit: "20" });
      if (searchAreaCode.trim()) params.set("area_code", searchAreaCode.trim());
      const resp = await api.get<{ numbers: AvailableNumber[] }>(
        `/voice/twilio/available-numbers?${params}`,
      );
      setAvailableNumbers(ensureArray<AvailableNumber>(resp.numbers));
      if (resp.numbers.length === 0) {
        toast("No numbers found for that area code. Try another.");
      }
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Search failed");
      setAvailableNumbers([]);
    } finally {
      setSearching(false);
    }
  };

  // ── Buy a number ──
  const confirmBuy = async () => {
    if (!buyingNumber || !agentName) return;
    setPurchasing(true);
    try {
      await api.post<{ phone_number: string; agent_name: string; provider_sid: string; status: string }>(
        "/voice/twilio/buy",
        { phone_number: buyingNumber.phone_number, agent_name: agentName },
      );
      toast(`Number ${formatPhone(buyingNumber.phone_number)} purchased and assigned to ${agentName}`);
      setBuyingNumber(null);
      setAvailableNumbers([]);
      setHasSearched(false);
      setSearchAreaCode("");
      await loadVoicePage();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Purchase failed");
    } finally {
      setPurchasing(false);
    }
  };

  // ── Remove a number ──
  const removeNumber = async (num: TwilioNumber) => {
    if (!window.confirm(`Release ${formatPhone(num.phone_number)}? This will remove it from Twilio and your agent.`)) return;
    try {
      await api.del(`/voice/twilio/numbers/${num.provider_sid}`);
      toast("Number released");
      await loadVoicePage();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to release number");
    }
  };

  // ── Test call ──
  const placeTestCall = async () => {
    if (!testCallFrom || !testCallTo.trim()) {
      toast("Enter the phone number to call (E.164, e.g. +15551234567)");
      return;
    }
    setPlacingTestCall(true);
    try {
      await api.post("/voice/twilio/test-call", {
        phone_number: testCallFrom,
        to: testCallTo.trim(),
      });
      toast("Test call initiated — your phone should ring shortly");
      setShowTestCall(false);
      setTestCallTo("");
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Test call failed");
    } finally {
      setPlacingTestCall(false);
    }
  };

  // ── Save voice settings ──
  const saveVoiceSettings = async () => {
    if (!agentName) return;
    setSavingSettings(true);
    try {
      await api.put("/voice/config", {
        agent_name: agentName,
        voice,
        greeting,
        language,
        max_duration: parseInt(maxDuration, 10) || 600,
      });
      setShowSettings(false);
      toast("Voice settings saved");
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to save voice settings");
    } finally {
      setSavingSettings(false);
    }
  };

  const copyNumber = (number: string) => {
    navigator.clipboard.writeText(number.replace(/[^+\d]/g, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Loading / error / not found states ──
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={24} className="animate-spin text-primary" />
        <span className="ml-2 text-sm text-text-secondary">Loading voice config...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-24">
        <p className="text-sm text-danger mb-2">{error}</p>
        <Button size="sm" variant="secondary" onClick={() => loadVoicePage()}>Retry</Button>
      </div>
    );
  }

  if (!agentName) return <AgentNotFound />;

  const activeNumbers = twilioNumbers.filter((n) => n.status === "active");
  const hasNumber = activeNumbers.length > 0;
  const completedCalls = calls.filter((c) => c.status === "completed");
  const totalMinutes = Math.round(calls.reduce((s, c) => s + c.duration_seconds, 0) / 60);

  return (
    <div>
      <AgentNav agentName={agentName}>
        <Button size="sm" variant="ghost" onClick={() => setShowSettings(true)}>
          <Settings size={14} /> Voice Settings
        </Button>
      </AgentNav>

      {!twilioConfigured && (
        <Card className="mb-6 border-warning bg-warning-light/50">
          <p className="text-sm text-warning-dark">
            <strong>Twilio is not configured on the server.</strong> Add{" "}
            <code className="text-xs bg-surface/80 px-1 rounded">TWILIO_ACCOUNT_SID</code> and{" "}
            <code className="text-xs bg-surface/80 px-1 rounded">TWILIO_AUTH_TOKEN</code> to your control-plane Worker secrets in Cloudflare,
            then redeploy.
          </p>
        </Card>
      )}

      {/* Stats bar */}
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
            <span className="text-xs text-text-secondary">Recent calls</span>
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
            <span className="text-xs text-text-secondary">Total minutes</span>
          </div>
          <p className="text-xl font-semibold text-text">{totalMinutes}</p>
        </Card>
      </div>

      {/* ── Section 1: Current Phone Number (if assigned) ── */}
      {hasNumber && (
        <div className="space-y-3 mb-8">
          <h2 className="text-lg font-medium text-text mb-3">Your Phone Number</h2>
          {activeNumbers.map((num) => (
            <Card key={num.id}>
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center">
                  <Phone size={24} className="text-success" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-semibold text-text">{formatPhone(num.phone_number)}</span>
                    <button type="button" onClick={() => copyNumber(num.phone_number)} className="p-1 text-text-muted hover:text-text transition-colors">
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                  <p className="text-xs text-text-muted">Twilio · Assigned to {num.agent_name} · Since {new Date(num.created_at).toLocaleDateString()}</p>
                </div>
                <Badge variant={num.status === "active" ? "success" : "default"}>{num.status}</Badge>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setTestCallFrom(num.phone_number);
                      setShowTestCall(true);
                    }}
                  >
                    <PhoneCall size={14} /> Test Call
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => removeNumber(num)}>
                    <PhoneOff size={14} />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ── Section 2: Get a Phone Number (if no number assigned) ── */}
      {!hasNumber && (
        <div className="mb-8">
          <h2 className="text-lg font-medium text-text mb-3">Get a Phone Number</h2>
          <Card>
            {!hasSearched && availableNumbers.length === 0 && (
              <div className="text-center py-8">
                <Phone size={36} className="mx-auto text-text-muted mb-3" />
                <p className="text-sm font-medium text-text mb-1">Add a phone number to your agent</p>
                <p className="text-xs text-text-muted mb-6">
                  Search for available numbers by area code, pick one you like, and it will be instantly assigned to your agent.
                </p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 items-end">
              <div className="flex-1 max-w-xs">
                <Input
                  label="Area code (optional)"
                  placeholder="e.g. 415, 212, 310"
                  value={searchAreaCode}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, "").slice(0, 3);
                    setSearchAreaCode(val);
                  }}
                  maxLength={3}
                />
              </div>
              <Button onClick={searchNumbers} disabled={searching || !twilioConfigured}>
                {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                Search Available Numbers
              </Button>
            </div>

            {/* Search results */}
            {hasSearched && availableNumbers.length > 0 && (
              <div className="mt-6">
                <p className="text-xs text-text-muted mb-3">{availableNumbers.length} numbers available{searchAreaCode ? ` in area code ${searchAreaCode}` : ""}</p>
                <div className="grid gap-2 max-h-96 overflow-y-auto">
                  {availableNumbers.map((num) => (
                    <div
                      key={num.phone_number}
                      className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/40 hover:bg-surface-alt transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-info-light flex items-center justify-center">
                          <Phone size={16} className="text-primary" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-text">{formatPhone(num.phone_number)}</p>
                          <p className="text-xs text-text-muted">
                            {[num.locality, num.region].filter(Boolean).join(", ") || "United States"}
                          </p>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setBuyingNumber(num)}
                      >
                        Select <ArrowRight size={12} />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {hasSearched && availableNumbers.length === 0 && !searching && (
              <p className="mt-4 text-sm text-text-muted text-center py-4">
                No numbers found. Try a different area code.
              </p>
            )}
          </Card>
        </div>
      )}

      {/* ── Section 3: Recent Calls ── */}
      <h2 className="text-lg font-medium text-text mb-3">Recent calls</h2>
      <div className="bg-surface rounded-xl border border-border divide-y divide-border mb-8">
        {calls.length === 0 && (
          <p className="p-6 text-sm text-text-muted text-center">No calls yet. {hasNumber ? "Try making a test call!" : "Get a phone number first."}</p>
        )}
        {calls.map((call) => {
          const status = callStatusConfig[call.status];
          const StatusIcon = status.icon;
          return (
            <button
              key={call.id}
              type="button"
              onClick={() => setSelectedCall(call)}
              className="w-full flex items-center gap-4 p-4 hover:bg-surface-alt transition-colors text-left"
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                call.status === "completed" ? "bg-success-light" : call.status === "missed" ? "bg-danger-light" : "bg-warning-light"
              }`}>
                <StatusIcon size={16} className={
                  call.status === "completed" ? "text-success" : call.status === "missed" ? "text-danger" : "text-warning"
                } />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text">{call.caller || "—"}</span>
                  <Badge variant={status.variant}>{status.label}</Badge>
                </div>
                {call.summary && (
                  <p className="text-xs text-text-muted mt-0.5 truncate">{call.summary}</p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs text-text-muted">{formatDuration(call.duration_seconds)}</p>
                <p className="text-xs text-text-muted">
                  {call.started_at ? new Date(call.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Buy Confirmation Modal ── */}
      <Modal open={!!buyingNumber} onClose={() => setBuyingNumber(null)} title="Confirm purchase">
        {buyingNumber && (
          <div className="space-y-4">
            <div className="text-center py-4">
              <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-4">
                <ShoppingCart size={28} className="text-success" />
              </div>
              <p className="text-lg font-semibold text-text mb-1">
                {formatPhone(buyingNumber.phone_number)}
              </p>
              <p className="text-sm text-text-muted">
                {[buyingNumber.locality, buyingNumber.region].filter(Boolean).join(", ") || "United States"}
              </p>
            </div>
            <div className="bg-surface-alt rounded-lg p-4">
              <p className="text-sm text-text">
                Buy <strong>{formatPhone(buyingNumber.phone_number)}</strong> and assign to <strong>{agentName}</strong>?
              </p>
              <p className="text-xs text-text-muted mt-2">
                This will cost $1.00/month. The number will be active immediately and incoming calls will be routed to your agent.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setBuyingNumber(null)} disabled={purchasing}>Cancel</Button>
              <Button onClick={confirmBuy} disabled={purchasing}>
                {purchasing ? <Loader2 size={14} className="animate-spin" /> : <ShoppingCart size={14} />}
                Buy Number
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Test Call Modal ── */}
      <Modal open={showTestCall} onClose={() => setShowTestCall(false)} title="Test call">
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            We will call your phone from your agent's number. The agent will answer the call as if it were a real inbound call.
          </p>
          <div className="bg-surface-alt rounded-lg p-3">
            <p className="text-xs text-text-muted mb-1">Calling from</p>
            <p className="text-sm font-medium text-text">{formatPhone(testCallFrom)}</p>
          </div>
          <Input
            label="Your phone number (E.164)"
            placeholder="+15551234567"
            value={testCallTo}
            onChange={(e) => setTestCallTo(e.target.value)}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setShowTestCall(false)}>Cancel</Button>
            <Button onClick={placeTestCall} disabled={placingTestCall || !testCallTo.trim()}>
              {placingTestCall ? <Loader2 size={14} className="animate-spin" /> : <PhoneCall size={14} />}
              Call Now
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Call Detail Modal ── */}
      <Modal open={!!selectedCall} onClose={() => setSelectedCall(null)} title="Call details" wide>
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
                  <p className="text-xs font-medium text-text-secondary mb-1">Summary</p>
                  <div className="bg-surface-alt rounded-lg p-4 text-sm text-text leading-relaxed">
                    {selectedCall.summary}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </Modal>

      {/* ── Voice Settings Modal ── */}
      <Modal open={showSettings} onClose={() => setShowSettings(false)} title="Voice settings">
        <div className="space-y-4">
          <Select label="Voice model (TTS)" value={voice} onChange={(e) => setVoice(e.target.value)} options={VOICES} />
          <Textarea label="First message (what the agent says when answering)" value={greeting} onChange={(e) => setGreeting(e.target.value)} rows={4} placeholder="Hello! Thanks for calling. How can I help you today?" />
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
            <Button onClick={saveVoiceSettings} disabled={savingSettings}>
              {savingSettings ? <Loader2 size={14} className="animate-spin" /> : null}
              Save
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
