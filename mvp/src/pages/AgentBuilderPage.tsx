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
import { Mail, Calendar, CreditCard, MessageSquare, Table, Users, Phone, Camera, Check, Loader2, AlertCircle, Sparkles, ChevronDown, ChevronUp, TestTube2 } from "lucide-react";

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

const EXAMPLES = [
  "Customer support agent for my coffee shop — answers questions about menu, hours, and handles order issues",
  "Sales assistant that qualifies inbound leads, asks about budget and timeline, then books a meeting",
  "Scheduling bot for a hair salon — handles bookings, cancellations, and sends reminders",
  "Personal assistant that helps me manage tasks, email triage, and quick research",
];

interface PersonalBuilderState {
  personalFlow?: boolean;
  suggestedName?: string;
  preferredChat?: string[];
  personalHelp?: string[];
}

interface CreateResult {
  agent_id?: string;
  name?: string;
  auto_eval?: {
    test_cases_generated: number;
    tasks: Array<{ name: string; input: string; expected: string }>;
    rubric: { pass_threshold: number };
  };
  tools?: string[];
  sub_agents_created?: number;
}

export default function AgentBuilderPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const initPersonal = useRef(false);

  // Mode: "quick" (default, single-step) or "advanced" (4-step wizard)
  const [mode, setMode] = useState<"quick" | "advanced">("quick");
  const [personalFlow, setPersonalFlow] = useState(false);
  const [personalHelpAreas, setPersonalHelpAreas] = useState<string[]>([]);

  // Quick mode state
  const [agentName, setAgentName] = useState("");
  const [description, setDescription] = useState("");
  const [plan, setPlan] = useState<"basic" | "standard" | "premium">("standard");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creationPhase, setCreationPhase] = useState("");
  const [creationSteps, setCreationSteps] = useState<{ label: string; done: boolean }[]>([]);
  const [createResult, setCreateResult] = useState<CreateResult | null>(null);

  // Advanced mode state (for power users who expand the form)
  const [step, setStep] = useState(0);
  const [useCase, setUseCase] = useState("");
  const [persona, setPersona] = useState("");
  const [tone, setTone] = useState("friendly");
  const [responseLength, setResponseLength] = useState("medium");
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

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

  /** Build a rich NL description for the meta-agent from ALL available context. */
  const buildMetaDescription = (): string => {
    const lines: string[] = [];

    if (personalFlow) {
      lines.push("Design a PERSONAL assistant for exactly one private user.");
      lines.push("Prioritize privacy; avoid exposing personal details.");
      if (personalHelpAreas.length > 0) {
        const bits = personalHelpAreas.map((id) => PERSONAL_HELP_COPY[id]).filter(Boolean);
        if (bits.length) lines.push(`Focus areas: ${bits.join("; ")}.`);
      }
      lines.push("Include tags personal-assistant and workspace:personal.");
    }

    lines.push(description.trim());

    if (persona.trim()) lines.push(`User-specified persona:\n${persona.trim()}`);
    if (tone !== "friendly") lines.push(`Tone: ${tone}.`);
    if (responseLength !== "medium") lines.push(`Response length: ${responseLength}.`);
    if (selectedTools.length > 0) {
      lines.push(`Requested integrations: ${selectedTools.join(", ")}.`);
    }
    if (useCase && useCase !== "custom") {
      const uc = USE_CASES.find((u) => u.id === useCase);
      if (uc) lines.push(`Primary use case: ${uc.label} — ${uc.description}`);
    }

    lines.push("Pick appropriate platform tools automatically. Generate test cases and evaluation rubrics.");

    return lines.filter(Boolean).join("\n\n");
  };

  const buildSystemPrompt = (): string => {
    const parts: string[] = [];
    if (persona.trim()) {
      parts.push(persona.trim());
    } else if (useCase === "personal_life") {
      parts.push("You are a personal assistant for a single private user. Prioritize privacy, clarity, and concise actionable replies.");
      if (personalHelpAreas.length > 0) {
        const bits = personalHelpAreas.map((id) => PERSONAL_HELP_COPY[id]).filter(Boolean);
        if (bits.length) parts.push(`Focus areas: ${bits.join("; ")}.`);
      }
      if (description.trim()) parts.push(`Context: ${description.trim()}`);
    } else {
      const uc = USE_CASES.find((u) => u.id === useCase);
      parts.push(description.trim() ? `You help customers with: ${description.trim()}` : "You are a helpful assistant for the business.");
      if (uc) parts.push(`Primary role: ${uc.label} — ${uc.description}`);
    }
    parts.push(`Speak in a ${tone} tone. Keep answers ${responseLength}.`);
    return parts.join("\n\n");
  };

  /** Quick Create: send description to meta-agent, get everything back. */
  const handleQuickCreate = async () => {
    const name = agentName.trim() || description.trim().split(/\s+/).slice(0, 3).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!description.trim()) {
      setCreateError("Tell us what your assistant should do.");
      return;
    }

    setCreating(true);
    setCreateError(null);
    setCreationPhase("Designing your agent with AI...");

    setCreationSteps([
      { label: "Analyzing your description", done: false },
      { label: "Designing system prompt", done: false },
      { label: "Selecting tools", done: false },
      { label: "Generating test cases", done: false },
    ]);

    // Simulate progress while API works
    const progressTimer = setInterval(() => {
      setCreationSteps((prev) => {
        const nextUndone = prev.findIndex((s) => !s.done);
        if (nextUndone === -1 || nextUndone >= prev.length - 1) return prev;
        return prev.map((s, i) => (i === nextUndone ? { ...s, done: true } : s));
      });
    }, 2500);

    try {
      const res = await api.post<CreateResult>("/agents/create-from-description", {
        description: buildMetaDescription(),
        name: name || undefined,
        tools: "auto",
        plan,
        draft_only: false,
        auto_graph: true,
      });

      clearInterval(progressTimer);
      setCreationSteps((prev) => prev.map((s) => ({ ...s, done: true })));

      setCreateResult(res);
      const agentPath = agentPathSegment(res.agent_id || res.name || name);

      // Show success with auto-eval info
      const testCount = res.auto_eval?.test_cases_generated || 0;
      const toolCount = Array.isArray(res.tools) ? res.tools.length : 0;
      const parts = ["Agent created"];
      if (toolCount > 0) parts.push(`${toolCount} tools`);
      if (testCount > 0) parts.push(`${testCount} test cases`);
      toast(parts.join(", ") + ".");

      // Navigate: personal flow → channels, business → tests (so they see auto-eval)
      if (personalFlow) {
        navigate(`/agents/${agentPath}/channels`);
      } else if (testCount > 0) {
        navigate(`/agents/${agentPath}/tests`);
      } else {
        navigate(`/agents/${agentPath}/play`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        clearInterval(progressTimer);
        setCreateError(err.message || "Rollout gate blocked creation. Try a different name or override in settings.");
        return;
      }
      // Fallback to simple creation — still create a complete agent with graph + tools
      if (err instanceof ApiError && (err.status === 422 || err.status >= 500)) {
        clearInterval(progressTimer);
        setCreationPhase("AI designer unavailable, creating with defaults...");
        try {
          // Use the same create-from-description but with simpler params
          // If that also fails, fall back to bare POST /agents with auto_graph
          let fallbackResult: any;
          try {
            fallbackResult = await api.post("/agents/create-from-description", {
              name,
              description: description.trim(),
              plan: plan,
              tools: "auto",
              auto_graph: true,
              draft_only: false,
            });
          } catch {
            // Final fallback — bare creation with auto_graph and default tools
            fallbackResult = await api.post("/agents", {
              name,
              description: description.trim(),
              system_prompt: buildSystemPrompt(),
              plan: plan,
              tools: selectedTools.length > 0 ? selectedTools : ["web-search", "python-exec", "browse"],
              auto_graph: true,
              tags: personalFlow ? ["workspace:personal"] : [],
            });
          }
          toast("Created assistant. Some AI features may be limited — check settings to customize.");
          navigate(`/agents/${agentPathSegment(fallbackResult?.name || name)}/play`);
          return;
        } catch (fallbackErr) {
          setCreateError(fallbackErr instanceof Error ? fallbackErr.message : "Failed to create assistant");
          return;
        }
      }
      clearInterval(progressTimer);
      setCreateError(err instanceof Error ? err.message : "Failed to create assistant");
    } finally {
      setCreating(false);
      setCreationPhase("");
    }
  };

  /** Advanced mode: uses the old 4-step wizard with manual control. */
  const handleAdvancedCreate = async () => {
    const name = agentName.trim();
    setCreating(true);
    setCreateError(null);

    try {
      // Always try meta-agent first (even in advanced mode) for graph + test generation
      try {
        const res = await api.post<CreateResult>("/agents/create-from-description", {
          description: buildMetaDescription(),
          name,
          tools: selectedTools.length > 0 ? selectedTools.join(",") : "auto",
          plan,
          draft_only: false,
        });
        const advPath = agentPathSegment(res.agent_id || res.name || name);
        const testCount = res.auto_eval?.test_cases_generated || 0;
        toast(`Assistant created with AI${testCount > 0 ? ` + ${testCount} test cases` : ""}.`);
        navigate(`/agents/${advPath}/${testCount > 0 ? "tests" : "activity"}`);
        return;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setCreateError(err.message || "Rollout gate blocked creation.");
          return;
        }
        // Fallback to standard
      }

      // Retry with simpler description — still through meta-agent
      const retryRes = await api.post<CreateResult>("/agents/create-from-description", {
        name,
        description: description.trim(),
        tools: selectedTools.length > 0 ? selectedTools.join(",") : "auto",
        plan,
        auto_graph: true,
        draft_only: false,
      });
      toast("Created assistant.");
      navigate(`/agents/${agentPathSegment(retryRes?.name || name)}/play`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create assistant");
    } finally {
      setCreating(false);
    }
  };

  const quickValid = description.trim().length > 0;
  const basicsValid = agentName.trim().length > 0 && description.trim().length > 0 && useCase.length > 0;
  const steps = ["Basics", "Behavior", "Tools", "Review"];
  const jobCases = personalFlow ? PERSONAL_USE_CASES : USE_CASES;

  // ── Quick Create Mode ──────────────────────────────────────────────
  if (mode === "quick") {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold text-text tracking-tight">
          {personalFlow ? PRODUCT.createPersonalAgentTitle : PRODUCT.createAgentTitle}
        </h1>
        <p className="text-sm text-text-secondary mt-2 mb-6 leading-relaxed">
          Describe what you need and AI will design everything — prompt, tools, conversation flow, and test cases.
        </p>

        <div className="bg-white rounded-xl border border-border p-6 sm:p-8 shadow-sm space-y-5">
          <Input
            label="Name (optional)"
            placeholder="e.g. Front Desk Helper"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
          />

          <Textarea
            label="What should this assistant do?"
            placeholder="e.g. Answer customer questions about our bakery menu, handle order inquiries, and help with delivery status..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
          />

          {/* Plan selection */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-text">LLM Plan</label>
            <div className="grid grid-cols-3 gap-2">
              {([
                { key: "basic" as const, label: "Basic", desc: "Free-tier models" },
                { key: "standard" as const, label: "Standard", desc: "GPT + Claude + Gemini" },
                { key: "premium" as const, label: "Premium", desc: "Top-tier models" },
              ]).map((p) => (
                <button
                  key={p.key}
                  onClick={() => setPlan(p.key)}
                  className={`p-2.5 rounded-lg border text-left transition-colors ${
                    plan === p.key
                      ? "border-primary bg-primary-light ring-1 ring-primary"
                      : "border-border hover:border-gray-300"
                  }`}
                >
                  <p className="text-sm font-semibold text-text">{p.label}</p>
                  <p className="text-[11px] text-text-secondary mt-0.5">{p.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Example prompts */}
          {!description.trim() && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-text-secondary">Try an example:</p>
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLES.map((ex, i) => (
                  <button
                    key={i}
                    onClick={() => setDescription(ex)}
                    className="text-xs px-2.5 py-1.5 rounded-full border border-border text-text-secondary hover:border-primary hover:text-primary transition-colors"
                  >
                    {ex.slice(0, 50)}...
                  </button>
                ))}
              </div>
            </div>
          )}

          {createError && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              <AlertCircle size={16} className="shrink-0" />
              <span>{createError}</span>
            </div>
          )}

          {/* Creating progress */}
          {creating && creationSteps.length > 0 && (
            <div className="p-4 rounded-lg bg-blue-50 border border-blue-200 space-y-2">
              {creationSteps.map((step, i) => (
                <div key={step.label} className="flex items-center gap-2.5 text-sm">
                  {step.done ? (
                    <Check size={14} className="text-green-600 shrink-0" />
                  ) : i === creationSteps.findIndex((s) => !s.done) ? (
                    <Loader2 size={14} className="animate-spin text-primary shrink-0" />
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full border border-gray-300 shrink-0" />
                  )}
                  <span className={step.done ? "text-text" : i === creationSteps.findIndex((s) => !s.done) ? "text-blue-700 font-medium" : "text-text-muted"}>
                    {step.label}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-end pt-2">
            <Button onClick={handleQuickCreate} disabled={creating || !quickValid}>
              {creating ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Building...
                </>
              ) : (
                <>
                  <Sparkles size={14} /> Create Agent
                </>
              )}
            </Button>
          </div>
          <p className="text-[10px] text-text-muted text-right mt-1">
            AI generates the system prompt, tools, test cases, and evaluation rubrics from your description.
          </p>
        </div>

        {/* What the AI handles */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "System prompt", desc: "Tailored to your business" },
            { label: "Tools", desc: "Auto-selected for the job" },
            { label: "Test cases", desc: "Auto-generated to verify quality" },
            { label: "Conversation flow", desc: "Graph designed automatically" },
          ].map((item) => (
            <div key={item.label} className="p-3 rounded-lg border border-border bg-white/50 text-center">
              <p className="text-xs font-medium text-text">{item.label}</p>
              <p className="text-xs text-text-secondary mt-0.5">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Advanced Mode (4-step wizard) ──────────────────────────────────
  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-semibold text-text tracking-tight">
          {personalFlow ? PRODUCT.createPersonalAgentTitle : PRODUCT.createAgentTitle}
        </h1>
        <button
          onClick={() => setMode("quick")}
          className="text-sm text-primary hover:text-primary/80 flex items-center gap-1 transition-colors"
        >
          <ChevronUp size={14} />
          Quick create
        </button>
      </div>
      <p className="text-sm text-text-secondary mt-2 mb-8 leading-relaxed">
        {personalFlow ? PRODUCT.createPersonalAgentIntro : PRODUCT.createAgentIntro}
      </p>

      <Card className="mb-4 p-3 bg-blue-50/60 border-blue-200">
        <p className="text-xs text-text-secondary leading-relaxed">
          Even in advanced mode, AI generates the execution graph, test cases, and evaluation rubrics from your inputs.
          You control the details — AI handles the complexity.
        </p>
      </Card>

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
                label="Persona / System prompt (optional — AI will generate one if blank)"
                placeholder="Leave blank to let AI design the perfect prompt, or write your own..."
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
                Pick tools or leave empty — AI will select the right ones automatically.
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
                    <dt className="text-text-secondary">Tools</dt>
                    <dd className="font-medium text-text">{selectedTools.length > 0 ? selectedTools.join(", ") : "Auto (AI selects)"}</dd>
                  </div>
                </dl>
              </Card>

              <Card className="bg-blue-50/60 border-blue-200">
                <div className="flex items-center gap-2 text-sm text-blue-700">
                  <TestTube2 size={16} />
                  <span>AI will also generate test cases and evaluation rubrics for this agent.</span>
                </div>
              </Card>

              {createError && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                  <AlertCircle size={16} className="shrink-0" />
                  <span>{createError}</span>
                </div>
              )}

              <div className="flex justify-between pt-2">
                <Button variant="ghost" onClick={() => setStep(2)}>Back</Button>
                <Button onClick={handleAdvancedCreate} disabled={creating}>
                  {creating ? (
                    <>
                      <Loader2 size={14} className="animate-spin" /> Creating...
                    </>
                  ) : (
                    <>
                      <Sparkles size={14} /> Create with AI
                    </>
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
