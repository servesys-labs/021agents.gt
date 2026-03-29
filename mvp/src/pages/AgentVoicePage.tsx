import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Phone, PhoneCall, PhoneOff, PhoneMissed, Settings, Volume2, Clock, Copy, Check, Plus, Loader2 } from "lucide-react";
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

interface PhoneNumber {
  id: string;
  number: string;
  label: string;
  provider: string;
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

function normalizeVapiList(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === "object") {
    const data = (body as { data?: unknown }).data;
    if (Array.isArray(data)) return data as Record<string, unknown>[];
  }
  return [];
}

export default function AgentVoicePage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();

  const [agentName, setAgentName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingLink, setSavingLink] = useState(false);
  const [placingCall, setPlacingCall] = useState(false);

  const [vapiConfigured, setVapiConfigured] = useState(false);
  const [vapiAssistantId, setVapiAssistantId] = useState("");
  const [vapiPhoneNumberId, setVapiPhoneNumberId] = useState("");

  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [showSetup, setShowSetup] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedCall, setSelectedCall] = useState<CallLog | null>(null);
  const [copied, setCopied] = useState(false);

  const [voice, setVoice] = useState("alloy");
  const [greeting, setGreeting] = useState("");
  const [language, setLanguage] = useState("en");
  const [maxDuration, setMaxDuration] = useState("600");

  const [vapiAssistants, setVapiAssistants] = useState<{ id: string; name: string }[]>([]);
  const [vapiPhones, setVapiPhones] = useState<{ id: string; number: string; label: string }[]>([]);
  const [loadingVapiLists, setLoadingVapiLists] = useState(false);
  const [pickAssistant, setPickAssistant] = useState("");
  const [pickPhone, setPickPhone] = useState("");

  const [testCallPhone, setTestCallPhone] = useState("");

  async function resolvePhoneDisplay(phoneId: string): Promise<string> {
    try {
      const body = await api.get<unknown>("/voice/vapi/phone-numbers");
      const list = normalizeVapiList(body);
      const found = list.find((p) => String(p.id ?? "") === phoneId);
      const n = String(found?.number ?? found?.phoneNumber ?? "");
      return n || phoneId;
    } catch {
      return phoneId;
    }
  }

  const loadVoicePage = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const seg = agentPathSegment(id);
    try {
      const agent = await api.get<{ name: string }>(`/agents/${seg}`);
      const name = agent.name ?? id;
      setAgentName(name);

      const config = await api.get<VoiceConfigResponse>(
        `/voice/config?agent_name=${encodeURIComponent(name)}`,
      );
      const configured = Boolean(config.vapi_configured);
      setVapiConfigured(configured);
      setVapiAssistantId(String(config.vapi_assistant_id ?? ""));
      setVapiPhoneNumberId(String(config.vapi_phone_number_id ?? ""));
      if (config.voice) setVoice(config.voice);
      if (config.greeting) setGreeting(config.greeting);
      if (config.language) setLanguage(config.language);
      if (config.max_duration != null) setMaxDuration(String(config.max_duration));
      setCalls(ensureArray<CallLog>(config.calls));

      const pid = String(config.vapi_phone_number_id ?? "");
      if (pid && configured) {
        const label = await resolvePhoneDisplay(pid);
        setNumbers([
          {
            id: pid,
            number: label,
            label: "Vapi line",
            provider: "vapi",
            status: "active",
            assigned_at: new Date().toISOString(),
          },
        ]);
      } else {
        setNumbers([]);
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

  const loadVapiResources = async () => {
    if (!vapiConfigured) {
      toast("VAPI_API_KEY is not set on the control plane. Add it in Cloudflare Worker secrets.");
      return;
    }
    setLoadingVapiLists(true);
    try {
      const [aBody, pBody] = await Promise.all([
        api.get<unknown>("/voice/vapi/assistants"),
        api.get<unknown>("/voice/vapi/phone-numbers"),
      ]);
      const rawA = normalizeVapiList(aBody);
      const rawP = normalizeVapiList(pBody);
      setVapiAssistants(
        rawA.map((x) => ({
          id: String(x.id ?? ""),
          name: String(x.name ?? x.model ?? x.id ?? "Assistant"),
        })).filter((x) => x.id),
      );
      setVapiPhones(
        rawP.map((x) => ({
          id: String(x.id ?? ""),
          number: String(x.number ?? x.phoneNumber ?? x.e164 ?? ""),
          label: String(x.name ?? x.friendlyName ?? x.number ?? x.id ?? ""),
        })).filter((x) => x.id),
      );
      setPickAssistant((prev) => prev || vapiAssistantId || "");
      setPickPhone((prev) => prev || vapiPhoneNumberId || "");
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Could not load Vapi assistants or phone numbers");
    } finally {
      setLoadingVapiLists(false);
    }
  };

  const openSetup = () => {
    setShowSetup(true);
    setPickAssistant(vapiAssistantId);
    setPickPhone(vapiPhoneNumberId);
    void loadVapiResources();
  };

  const saveVoiceLink = async () => {
    if (!id || !agentName) return;
    if (!pickAssistant || !pickPhone) {
      toast("Choose a Vapi assistant and a phone number");
      return;
    }
    setSavingLink(true);
    try {
      const res = await api.put<{ ok: boolean; vapi_configured?: boolean; vapi_config_error?: string }>("/voice/config", {
        agent_name: agentName,
        voice,
        greeting,
        language,
        max_duration: parseInt(maxDuration, 10) || 600,
        vapi_assistant_id: pickAssistant,
        vapi_phone_number_id: pickPhone,
      });
      setVapiAssistantId(pickAssistant);
      setVapiPhoneNumberId(pickPhone);
      setShowSetup(false);
      if (res?.vapi_configured) {
        toast("Voice linked — your agent's brain is now connected to voice calls.");
      } else if (res?.vapi_config_error) {
        toast(`Voice linked, but Vapi auto-config failed: ${res.vapi_config_error}`);
      } else {
        toast("Voice linked — inbound calls to this Vapi number will use this agent.");
      }
      await loadVoicePage();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingLink(false);
    }
  };

  const clearVoiceLink = async () => {
    if (!agentName) return;
    if (!window.confirm("Remove the linked Vapi phone number from this agent?")) return;
    setSavingLink(true);
    try {
      await api.put("/voice/config", {
        agent_name: agentName,
        vapi_assistant_id: "",
        vapi_phone_number_id: "",
      });
      setVapiAssistantId("");
      setVapiPhoneNumberId("");
      setNumbers([]);
      toast("Voice link removed");
      await loadVoicePage();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setSavingLink(false);
    }
  };

  const placeTestCall = async () => {
    if (!vapiAssistantId || !vapiPhoneNumberId) {
      toast("Link a Vapi assistant and phone number first");
      return;
    }
    const dest = testCallPhone.trim();
    if (!dest) {
      toast("Enter the customer phone number (E.164, e.g. +15551234567)");
      return;
    }
    setPlacingCall(true);
    try {
      await api.post("/voice/vapi/calls", {
        phone_number_id: vapiPhoneNumberId,
        customer_phone: dest,
        assistant_id: vapiAssistantId,
        agent_name: agentName,
        first_message: greeting.trim() || undefined,
      });
      toast("Outbound call started");
      setTestCallPhone("");
      await loadVoicePage();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Call failed");
    } finally {
      setPlacingCall(false);
    }
  };

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
        vapi_assistant_id: vapiAssistantId,
        vapi_phone_number_id: vapiPhoneNumberId,
      });
      setShowSettings(false);
      toast("Voice settings saved");
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to save voice settings");
    } finally {
      setSavingSettings(false);
    }
  };

  const toggleNumber = (numId: string) => {
    setNumbers((prev) =>
      prev.map((n) =>
        n.id === numId ? { ...n, status: n.status === "active" ? "inactive" : "active" } : n,
      ),
    );
  };

  const copyNumber = (number: string) => {
    navigator.clipboard.writeText(number.replace(/[^+\d]/g, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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

  const activeNumbers = numbers.filter((n) => n.status === "active");
  const completedCalls = calls.filter((c) => c.status === "completed");
  const totalMinutes = Math.round(calls.reduce((s, c) => s + c.duration_seconds, 0) / 60);

  return (
    <div>
      <AgentNav agentName={agentName}>
        <Button size="sm" variant="ghost" onClick={() => setShowSettings(true)}>
          <Settings size={14} /> Voice Settings
        </Button>
        <Button size="sm" onClick={openSetup}>
          <Plus size={14} /> {vapiPhoneNumberId ? "Change Vapi link" : "Link Vapi"}
        </Button>
      </AgentNav>

      {!vapiConfigured && (
        <Card className="mb-6 border-amber-200 bg-amber-50/50">
          <p className="text-sm text-amber-900">
            <strong>Vapi is not configured on the server.</strong> Add{" "}
            <code className="text-xs bg-white/80 px-1 rounded">VAPI_API_KEY</code> to your control-plane Worker secrets in Cloudflare,
            then redeploy. This app never stores your Vapi key in the browser.
          </p>
        </Card>
      )}

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

      {vapiConfigured && vapiAssistantId && vapiPhoneNumberId && (
        <Card className="mb-8">
          <p className="text-sm font-medium text-text mb-3">Test outbound call</p>
          <p className="text-xs text-text-muted mb-3">
            Uses your linked Vapi phone number as caller ID and the linked assistant. Charges apply per Vapi.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="flex-1">
              <Input
                label="Customer phone (E.164)"
                placeholder="+15551234567"
                value={testCallPhone}
                onChange={(e) => setTestCallPhone(e.target.value)}
              />
            </div>
            <Button onClick={placeTestCall} disabled={placingCall}>
              {placingCall ? <Loader2 size={14} className="animate-spin" /> : <PhoneCall size={14} />}
              Call now
            </Button>
          </div>
        </Card>
      )}

      <h2 className="text-lg font-medium text-text mb-3">Phone numbers</h2>
      {numbers.length === 0 ? (
        <Card className="mb-8">
          <div className="text-center py-8">
            <Phone size={36} className="mx-auto text-text-muted mb-3" />
            <p className="text-sm font-medium text-text mb-1">No Vapi number linked</p>
            <p className="text-xs text-text-muted mb-4">
              Link a Vapi assistant and phone number purchased in your Vapi dashboard. The API key stays on Cloudflare.
            </p>
            <Button size="sm" onClick={openSetup} disabled={!vapiConfigured}>
              <Plus size={14} /> Link Vapi
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
                    <button type="button" onClick={() => copyNumber(num.number)} className="p-0.5 text-text-muted hover:text-text">
                      {copied ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  </div>
                  <p className="text-xs text-text-muted">{num.label} · Vapi · assistant {vapiAssistantId.slice(0, 8)}…</p>
                </div>
                <Badge variant={num.status === "active" ? "success" : "default"}>{num.status}</Badge>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => toggleNumber(num.id)}
                    className={`relative w-10 h-6 rounded-full transition-colors ${num.status === "active" ? "bg-success" : "bg-gray-200"}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${num.status === "active" ? "translate-x-4" : ""}`} />
                  </button>
                  <Button size="sm" variant="ghost" onClick={clearVoiceLink} disabled={savingLink}>
                    <PhoneOff size={14} />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <h2 className="text-lg font-medium text-text mb-3">Recent calls</h2>
      <div className="bg-white rounded-xl border border-border divide-y divide-border">
        {calls.length === 0 && (
          <p className="p-6 text-sm text-text-muted text-center">No calls yet (webhook must point to your control plane for history).</p>
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
                call.status === "completed" ? "bg-emerald-50" : call.status === "missed" ? "bg-red-50" : "bg-amber-50"
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

      <Modal open={showSetup} onClose={() => setShowSetup(false)} title="Link Vapi to this agent">
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Choose the Vapi <strong>assistant</strong> and <strong>phone number</strong> from your Vapi account. Requests use the{" "}
            <code className="text-xs bg-surface-alt px-1 rounded">VAPI_API_KEY</code> stored on the control plane (Cloudflare), not in this browser.
          </p>
          <div className="flex justify-end">
            <Button type="button" size="sm" variant="secondary" onClick={loadVapiResources} disabled={loadingVapiLists || !vapiConfigured}>
              {loadingVapiLists ? <Loader2 size={14} className="animate-spin" /> : null}
              Refresh lists
            </Button>
          </div>
          <Select
            label="Vapi assistant"
            value={pickAssistant}
            onChange={(e) => setPickAssistant(e.target.value)}
            options={[
              { value: "", label: loadingVapiLists ? "Loading…" : "Select assistant" },
              ...vapiAssistants.map((a) => ({ value: a.id, label: `${a.name} (${a.id.slice(0, 8)}…)` })),
            ]}
          />
          <Select
            label="Vapi phone number"
            value={pickPhone}
            onChange={(e) => setPickPhone(e.target.value)}
            options={[
              { value: "", label: loadingVapiLists ? "Loading…" : "Select number" },
              ...vapiPhones.map((p) => ({
                value: p.id,
                label: p.number ? `${p.number} — ${p.label || p.id.slice(0, 8)}` : p.id,
              })),
            ]}
          />
          <p className="text-xs text-text-muted">
            Buy or import numbers in{" "}
            <a href="https://dashboard.vapi.ai" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              dashboard.vapi.ai
            </a>
            . Point Vapi webhooks to your control plane <code className="text-[10px]">/api/v1/voice/vapi/webhook</code> (with signature secret if configured).
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setShowSetup(false)}>Cancel</Button>
            <Button onClick={saveVoiceLink} disabled={savingLink || !vapiConfigured || !pickAssistant || !pickPhone}>
              {savingLink ? <Loader2 size={14} className="animate-spin" /> : null}
              Save link
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={showSettings} onClose={() => setShowSettings(false)} title="Voice settings">
        <div className="space-y-4">
          <Select label="Voice (UI / future TTS mapping)" value={voice} onChange={(e) => setVoice(e.target.value)} options={VOICES} />
          <Textarea label="Greeting (used for test outbound calls)" value={greeting} onChange={(e) => setGreeting(e.target.value)} rows={4} />
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
            label="Max call duration (seconds)"
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
