import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { StepWizard } from "../components/StepWizard";
import { Card } from "../components/ui/Card";
import { api, ApiError } from "../lib/api";
import { useToast } from "../components/ui/Toast";
import { PRODUCT } from "../lib/product";
import { agentPathSegment } from "../lib/agent-path";
import { Mail, Calendar, CreditCard, MessageSquare, Table, Users, Phone, Camera, Check, Loader2, AlertCircle } from "lucide-react";

const iconMap: Record<string, React.ComponentType<any>> = {
  Mail, Calendar, CreditCard, MessageSquare, Table, Users, Phone, Camera,
};

const USE_CASES = [
  { id: "customer_support", label: "Customer Support", description: "Answer questions, resolve issues, handle FAQs" },
  { id: "sales", label: "Sales & Lead Qualification", description: "Qualify leads, book meetings, follow up on inquiries" },
  { id: "scheduling", label: "Scheduling & Bookings", description: "Handle appointments, reservations, and calendar management" },
  { id: "order_management", label: "Order Management", description: "Track orders, process returns, update delivery status" },
  { id: "onboarding", label: "Client Onboarding", description: "Guide new customers through setup and first steps" },
  { id: "custom", label: "Custom", description: "Build a custom agent from scratch" },
];

const PERSONAL_USE_CASES = [
  {
    id: "personal_life",
    label: "Personal assistant",
    description: "Private help for one user—tasks, calendar, reminders, chat in Telegram / WhatsApp / Slack.",
  },
  { id: "custom", label: "Custom", description: "Define everything yourself in the persona field." },
];

const PERSONAL_HELP_COPY: Record<string, string> = {
  tasks_reminders: "tasks, reminders, and follow-ups",
  calendar_email: "calendar and email triage",
  research: "research and reading summaries",
  notes: "notes and quick capture",
  travel_home: "travel and life admin",
};

/** Rich NL description for POST /agents/create-from-description (meta-agent / LLM). */
function buildPersonalMetaDescription(input: {
  description: string;
  persona: string;
  tone: string;
  responseLength: string;
  personalHelpAreas: string[];
  selectedTools: string[];
  useCase: string;
}): string {
  const { description, persona, tone, responseLength, personalHelpAreas, selectedTools, useCase } = input;
  const lines: string[] = [
    "Design a PERSONAL assistant for exactly one private user (not a public storefront or anonymous customer-support bot).",
    "Typical day: brief news digests when asked, deeper research, coding/debugging help, tasks and reminders, email triage or summaries when mail tools/connectors exist, and clear next steps.",
    "Treat all context as sensitive; prioritize privacy; avoid exposing personal details unnecessarily.",
    `Tone: ${tone}. Default answer length: ${responseLength} (unless the user asks for more detail).`,
  ];
  if (description.trim()) lines.push(`User's own summary of what they want:\n${description.trim()}`);
  if (persona.trim()) lines.push(`User-specified persona (follow closely):\n${persona.trim()}`);
  if (personalHelpAreas.length > 0) {
    const bits = personalHelpAreas.map((id) => PERSONAL_HELP_COPY[id]).filter(Boolean);
    if (bits.length) lines.push(`Extra focus: ${bits.join("; ")}.`);
  }
  if (selectedTools.length > 0) {
    lines.push(
      `They ticked integration interests in the UI — map to real tools/MCP (Gmail, Calendar, Slack, etc.) as appropriate: ${selectedTools.join(", ")}.`,
    );
  }
  if (useCase === "custom") lines.push("Use case is custom — weight the user's description and persona above any generic template.");
  lines.push(
    "Pick strong platform tools where relevant (e.g. web-search, browse, knowledge-search, bash, python-exec, http-request, send-email).",
    "Include tags personal-assistant and workspace:personal. Keep governance reasonable for a single-user assistant.",
  );
  return lines.join("\n\n");
}

const TOOLS = [
  { id: "email", label: "Email", icon: "Mail", description: "Send and read emails" },
  { id: "calendar", label: "Calendar", icon: "Calendar", description: "Manage appointments and schedules" },
  { id: "stripe", label: "Stripe", icon: "CreditCard", description: "Process payments and manage orders" },
  { id: "slack", label: "Slack", icon: "MessageSquare", description: "Send messages and notifications" },
  { id: "sheets", label: "Google Sheets", icon: "Table", description: "Read and write spreadsheet data" },
  { id: "crm", label: "CRM", icon: "Users", description: "Manage contacts and deals" },
  { id: "whatsapp", label: "WhatsApp", icon: "Phone", description: "Message customers on WhatsApp" },
  { id: "instagram", label: "Instagram", icon: "Camera", description: "Respond to DMs and comments" },
];

const steps = ["Basics", "Behavior", "Tools", "Review"];

interface PersonalBuilderState {
  personalFlow?: boolean;
  suggestedName?: string;
  preferredChat?: string[];
  personalHelp?: string[];
}

export default function AgentBuilderPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const initPersonal = useRef(false);

  const [personalFlow, setPersonalFlow] = useState(false);
  const [personalHelpAreas, setPersonalHelpAreas] = useState<string[]>([]);

  const [step, setStep] = useState(0);
  const [agentName, setAgentName] = useState("");
  const [description, setDescription] = useState("");
  const [useCase, setUseCase] = useState("");
  const [persona, setPersona] = useState("");
  const [tone, setTone] = useState("friendly");
  const [responseLength, setResponseLength] = useState("medium");
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (initPersonal.current) return;
    const s = location.state as PersonalBuilderState | null;
    const fromQuery = searchParams.get("kind") === "personal";
    if (!s?.personalFlow && !fromQuery) return;
    initPersonal.current = true;
    setPersonalFlow(true);
    if (s?.suggestedName?.trim()) setAgentName(s.suggestedName.trim());
    if (s?.personalHelp?.length) setPersonalHelpAreas(s.personalHelp);
    setUseCase("personal_life");
    if (s?.preferredChat?.length) {
      const next: string[] = [];
      if (s.preferredChat.includes("slack")) next.push("slack");
      if (s.preferredChat.includes("whatsapp")) next.push("whatsapp");
      setSelectedTools(next);
    }
    if (fromQuery && !s?.suggestedName) {
      setAgentName((n) => n || "My assistant");
      setDescription((d) => d || "My private assistant for tasks, calendar, and chat.");
    } else if (s?.suggestedName) {
      setDescription((d) =>
        d.trim()
          ? d
          : "Personal assistant for private tasks and messaging—connect Telegram, WhatsApp, or Slack under Channels.",
      );
    }
  }, [location.state, searchParams]);

  const toggleTool = (id: string) =>
    setSelectedTools((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const buildSystemPrompt = (): string => {
    const parts: string[] = [];
    if (persona.trim()) {
      parts.push(persona.trim());
    } else if (useCase === "personal_life") {
      parts.push(
        "You are a personal assistant for a single private user. Prioritize privacy, clarity, and concise actionable replies.",
      );
      if (personalHelpAreas.length > 0) {
        const bits = personalHelpAreas.map((id) => PERSONAL_HELP_COPY[id]).filter(Boolean);
        if (bits.length) parts.push(`Focus areas: ${bits.join("; ")}.`);
      }
      if (description.trim()) parts.push(`Context: ${description.trim()}`);
    } else {
      const uc = USE_CASES.find((u) => u.id === useCase);
      parts.push(
        description.trim()
          ? `You help customers with: ${description.trim()}`
          : "You are a helpful assistant for the business.",
      );
      if (uc) parts.push(`Primary role: ${uc.label} — ${uc.description}`);
    }
    parts.push(`Speak in a ${tone} tone. Keep answers ${responseLength}.`);
    return parts.join("\n\n");
  };

  const handleCreate = async () => {
    const name = agentName.trim();
    setCreating(true);
    setCreateError(null);
    const tags = useCase ? [useCase, ...(personalFlow ? ["workspace:personal"] : [])] : personalFlow ? ["workspace:personal"] : [];

    const createStandard = () =>
      api.post("/agents", {
        name,
        description: description.trim(),
        system_prompt: buildSystemPrompt(),
        tools: selectedTools,
        tags,
      });

    try {
      if (personalFlow) {
        try {
          const res = await api.post<{ name?: string }>("/agents/create-from-description", {
            description: buildPersonalMetaDescription({
              description,
              persona,
              tone,
              responseLength,
              personalHelpAreas,
              selectedTools,
              useCase,
            }),
            name,
            tools: "auto",
            draft_only: false,
          });
          const createdName = String(res.name || name);
          toast("Designed your assistant with AI — review tools and channels next.");
          navigate(`/agents/${agentPathSegment(createdName)}/channels`);
          return;
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            setCreateError(
              err.message || "Rollout gate blocked creation. Override from the full portal or pick another name.",
            );
            return;
          }
          const hint =
            err instanceof ApiError && err.status === 422
              ? "AI package did not pass validation — saving a simpler assistant from your answers."
              : "AI agent designer unavailable (check OPENROUTER_API_KEY on the control plane). Saving from your answers instead.";
          toast(hint);
          await createStandard();
          navigate(`/agents/${agentPathSegment(name)}/channels`);
          return;
        }
      }

      await createStandard();
      const path = agentPathSegment(name);
      navigate(`/agents/${path}/activity`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create assistant");
    } finally {
      setCreating(false);
    }
  };

  const basicsValid = agentName.trim().length > 0 && description.trim().length > 0 && useCase.length > 0;
  const jobCases = personalFlow ? PERSONAL_USE_CASES : USE_CASES;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold text-text tracking-tight">
        {personalFlow ? PRODUCT.createPersonalAgentTitle : PRODUCT.createAgentTitle}
      </h1>
      <p className="text-sm text-text-secondary mt-2 mb-8 leading-relaxed">
        {personalFlow ? PRODUCT.createPersonalAgentIntro : PRODUCT.createAgentIntro}
      </p>
      {personalFlow && (
        <Card className="mb-6 p-4 bg-violet-50/80 border-violet-200">
          <p className="text-sm text-text leading-relaxed">
            We send your answers to the control plane <strong>meta-agent</strong> (<code className="text-xs">create-from-description</code>) so an LLM can draft a full system prompt, tools, and graph. If that service is unavailable, we fall back to a simple template from this form.
            Afterward you’ll open <strong>Channels</strong> for Telegram, WhatsApp, and Slack setup.
          </p>
        </Card>
      )}

      <div className="bg-white rounded-xl border border-border p-6 sm:p-8 shadow-sm">
        <StepWizard steps={steps} currentStep={step}>
          {/* Step 1: Basics */}
          {step === 0 && (
            <div className="space-y-4">
              <Input
                label="Assistant name"
                placeholder="e.g. Front desk helper"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
              />
              <Textarea
                label={personalFlow ? "What you want help with" : "What they do"}
                placeholder={
                  personalFlow
                    ? "e.g. keep my tasks straight, draft short replies, remind me before meetings..."
                    : "Short description customers would understand—e.g. answers product questions and checks order status."
                }
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-text">{personalFlow ? "Assistant type" : "Primary job"}</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {jobCases.map((uc) => (
                    <button
                      key={uc.id}
                      type="button"
                      onClick={() => setUseCase(uc.id)}
                      className={`text-left p-3 rounded-lg border text-sm transition-colors ring-offset-2 focus:outline-none focus:ring-2 focus:ring-primary/30 ${
                        useCase === uc.id ? "border-primary bg-primary-light shadow-sm" : "border-border hover:border-gray-300"
                      }`}
                    >
                      <p className="font-medium text-text">{uc.label}</p>
                      <p className="text-xs text-text-secondary mt-0.5 leading-snug">{uc.description}</p>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end pt-4">
                <Button onClick={() => setStep(1)} disabled={!basicsValid}>
                  Continue
                </Button>
              </div>
            </div>
          )}

          {/* Step 2: Behavior */}
          {step === 1 && (
            <div className="space-y-4">
              <Textarea
                label="Persona / System prompt"
                placeholder="You are a helpful assistant for a flower shop. You help customers with questions about flowers, delivery, and orders..."
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                rows={5}
              />
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-text">Tone</label>
                <div className="flex gap-2">
                  {["friendly", "professional", "casual"].map((t) => (
                    <button
                      key={t}
                      onClick={() => setTone(t)}
                      className={`px-4 py-2 rounded-lg border text-sm font-medium capitalize transition-colors ${
                        tone === t ? "border-primary bg-primary-light text-primary" : "border-border text-text-secondary hover:border-gray-300"
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
                        responseLength === l ? "border-primary bg-primary-light text-primary" : "border-border text-text-secondary hover:border-gray-300"
                      }`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-between pt-4">
                <Button variant="ghost" onClick={() => setStep(0)}>Back</Button>
                <Button onClick={() => setStep(2)}>Continue</Button>
              </div>
            </div>
          )}

          {/* Step 3: Tools */}
          {step === 2 && (
            <div>
              <p className="text-sm text-text-secondary mb-4">
                {personalFlow
                  ? "Pick tools this assistant may use (Slack / WhatsApp match chat apps you chose in onboarding)."
                  : "Pick the tools your agent can use."}
              </p>
              <div className="grid grid-cols-2 gap-3">
                {TOOLS.map((tool) => {
                  const Icon = iconMap[tool.icon];
                  const selected = selectedTools.includes(tool.id);
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
                        <p className="text-xs text-text-muted truncate">{tool.description}</p>
                      </div>
                      {selected && <Check size={16} className="text-primary shrink-0" />}
                    </button>
                  );
                })}
              </div>
              <div className="flex justify-between pt-6">
                <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
                <Button onClick={() => setStep(3)}>Review</Button>
              </div>
            </div>
          )}

          {/* Step 4: Review */}
          {step === 3 && (
            <div className="space-y-4">
              <Card>
                <dl className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-text-secondary">Name</dt>
                    <dd className="font-medium text-text">{agentName || "—"}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-text-secondary">Use case</dt>
                    <dd className="font-medium text-text capitalize">{useCase.replace("_", " ") || "—"}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-text-secondary">Tone</dt>
                    <dd className="font-medium text-text capitalize">{tone}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-text-secondary">Response length</dt>
                    <dd className="font-medium text-text capitalize">{responseLength}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-text-secondary">Tools</dt>
                    <dd className="font-medium text-text">{selectedTools.length > 0 ? selectedTools.join(", ") : "None"}</dd>
                  </div>
                  {persona && (
                    <div>
                      <dt className="text-text-secondary mb-1">Persona</dt>
                      <dd className="text-text bg-surface-alt rounded-lg p-3 text-xs">{persona}</dd>
                    </div>
                  )}
                </dl>
              </Card>

              {createError && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                  <AlertCircle size={16} className="shrink-0" />
                  <span>{createError}</span>
                </div>
              )}

              <div className="flex justify-between pt-2">
                <Button variant="ghost" onClick={() => setStep(2)}>Back</Button>
                <Button onClick={handleCreate} disabled={creating}>
                  {creating ? (
                    <>
                      <Loader2 size={14} className="animate-spin" /> Creating...
                    </>
                  ) : (
                    "Create assistant"
                  )}
                </Button>
              </div>
            </div>
          )}
        </StepWizard>
      </div>
    </div>
  );
}
