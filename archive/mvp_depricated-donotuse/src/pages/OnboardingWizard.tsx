import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, ArrowRight, Check, Loader2, Sparkles, MessageSquare, ShoppingBag, Calendar, Headphones, Users, Wrench } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card } from "../components/ui/Card";
import { api, ApiError } from "../lib/api";
import { useToast } from "../components/ui/Toast";
import { agentPathSegment } from "../lib/agent-path";

const USE_CASES = [
  { id: "support", label: "Customer Support", desc: "Answer questions, resolve issues, handle FAQs", icon: Headphones },
  { id: "sales", label: "Sales & Leads", desc: "Qualify leads, book meetings, follow up", icon: Users },
  { id: "scheduling", label: "Scheduling", desc: "Appointments, reservations, calendar", icon: Calendar },
  { id: "orders", label: "Order Management", desc: "Track orders, returns, delivery updates", icon: ShoppingBag },
  { id: "general", label: "General Assistant", desc: "Research, writing, analysis, anything", icon: Bot },
  { id: "custom", label: "Something else", desc: "Describe what you need in your own words", icon: Wrench },
];

interface CreationStep {
  label: string;
  done: boolean;
}

export default function OnboardingWizard() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [step, setStep] = useState(1);
  const [businessName, setBusinessName] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [useCase, setUseCase] = useState("");
  const [customDesc, setCustomDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [creationSteps, setCreationSteps] = useState<CreationStep[]>([]);

  const buildDescription = () => {
    const biz = businessName ? `for ${businessName}` : "";
    const type = businessType ? ` (${businessType})` : "";
    const selected = USE_CASES.find(u => u.id === useCase);

    if (useCase === "custom" && customDesc) {
      return `Create an AI assistant ${biz}${type}. ${customDesc}`;
    }
    if (selected) {
      return `Create an AI assistant ${biz}${type} focused on ${selected.label.toLowerCase()}: ${selected.desc.toLowerCase()}. Make it friendly, professional, and helpful.`;
    }
    return `Create a general-purpose AI assistant ${biz}${type}. It should be able to answer questions, help with tasks, search the web, and assist with day-to-day work.`;
  };

  const handleCreate = async () => {
    setCreating(true);
    setError("");
    setCreationSteps([
      { label: "Understanding your business", done: false },
      { label: "Designing your assistant's personality", done: false },
      { label: "Selecting the right tools", done: false },
      { label: "Creating test scenarios", done: false },
    ]);

    const progressTimer = setInterval(() => {
      setCreationSteps(prev => {
        const next = prev.findIndex(s => !s.done);
        if (next === -1 || next >= prev.length - 1) return prev;
        return prev.map((s, i) => i === next ? { ...s, done: true } : s);
      });
    }, 2000);

    try {
      const agentName = businessName
        ? businessName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) + "-assistant"
        : "my-business-assistant";

      const res = await api.post<any>("/agents/create-from-description", {
        description: buildDescription(),
        name: agentName,
        tools: "auto",
        plan: "standard",
        draft_only: false,
      });

      clearInterval(progressTimer);
      setCreationSteps(prev => prev.map(s => ({ ...s, done: true })));

      // Mark onboarding complete
      api.post("/org/settings", { onboarding_complete: true }).catch(() => {});

      const toolCount = Array.isArray(res.tools) ? res.tools.length : 0;
      toast(`Assistant created with ${toolCount} tools!`);

      // Brief pause to show all checkmarks, then navigate
      setTimeout(() => {
        const path = agentPathSegment(res.agent_id || res.name || agentName);
        navigate(`/agents/${path}/play`);
      }, 800);
    } catch (err: any) {
      clearInterval(progressTimer);

      // Fallback: create a basic agent if meta-agent fails
      if (err instanceof ApiError && (err.status === 422 || err.status >= 500)) {
        try {
          const fallbackName = businessName
            ? businessName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30) + "-assistant"
            : "my-assistant";

          await api.post("/agents", {
            name: fallbackName,
            description: buildDescription(),
            plan: "standard",
          });

          setCreationSteps(prev => prev.map(s => ({ ...s, done: true })));
          api.post("/org/settings", { onboarding_complete: true }).catch(() => {});
          toast("Assistant created!");

          setTimeout(() => navigate(`/agents/${fallbackName}/play`), 800);
          return;
        } catch {}
      }

      setError(err.message || "Failed to create assistant. Try again.");
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-alt flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2.5 mb-3">
            <div className="w-10 h-10 bg-primary rounded-xl flex items-center justify-center">
              <Bot size={20} className="text-white" />
            </div>
          </div>
          <h1 className="text-xl font-bold text-text">
            {step === 1 ? "Tell us about your business" :
             step === 2 ? "What do you need help with?" :
             "Creating your assistant..."}
          </h1>
          <p className="text-sm text-text-secondary mt-2">
            {step === 1 ? "We'll design an AI assistant tailored to you" :
             step === 2 ? "Pick a use case — you can change this later" :
             "This takes about 15 seconds"}
          </p>
        </div>

        {/* Progress dots */}
        <div className="flex justify-center gap-2 mb-8">
          {[1, 2, 3].map(s => (
            <div
              key={s}
              className={`w-2 h-2 rounded-full transition-colors ${
                s === step ? "bg-primary" : s < step ? "bg-primary/40" : "bg-border"
              }`}
            />
          ))}
        </div>

        {/* Step 1: Business info */}
        {step === 1 && (
          <div className="bg-surface rounded-xl border border-border p-6 space-y-4">
            <Input
              label="Business name"
              placeholder="e.g. Maria's Bakery, Acme Corp"
              value={businessName}
              onChange={e => setBusinessName(e.target.value)}
              autoFocus
            />
            <Input
              label="What kind of business?"
              placeholder="e.g. Restaurant, SaaS, Salon, E-commerce"
              value={businessType}
              onChange={e => setBusinessType(e.target.value)}
            />
            <div className="flex justify-between pt-2">
              <Button variant="ghost" size="sm" onClick={() => {
                setStep(2);
              }}>
                Skip
              </Button>
              <Button onClick={() => setStep(2)}>
                Next <ArrowRight size={14} />
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Use case */}
        {step === 2 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {USE_CASES.map(uc => {
                const Icon = uc.icon;
                const selected = useCase === uc.id;
                return (
                  <button
                    key={uc.id}
                    onClick={() => setUseCase(uc.id)}
                    className={`p-4 rounded-xl border text-left transition-all ${
                      selected
                        ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                        : "border-border bg-surface hover:border-primary/30"
                    }`}
                  >
                    <Icon size={20} className={selected ? "text-primary" : "text-text-muted"} />
                    <p className="text-sm font-medium text-text mt-2">{uc.label}</p>
                    <p className="text-xs text-text-secondary mt-0.5">{uc.desc}</p>
                  </button>
                );
              })}
            </div>

            {useCase === "custom" && (
              <Input
                label="Describe what you need"
                placeholder="e.g. An assistant that helps customers find products and check stock levels"
                value={customDesc}
                onChange={e => setCustomDesc(e.target.value)}
                autoFocus
              />
            )}

            {error && (
              <p className="text-sm text-danger bg-danger-light px-3 py-2 rounded-lg">{error}</p>
            )}

            <div className="flex justify-between pt-2">
              <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button onClick={() => { setStep(3); handleCreate(); }} disabled={creating}>
                <Sparkles size={14} /> Create my assistant
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Creating */}
        {step === 3 && (
          <div className="bg-surface rounded-xl border border-border p-6">
            <div className="space-y-4">
              {creationSteps.map((s, i) => (
                <div key={i} className="flex items-center gap-3">
                  {s.done ? (
                    <div className="w-6 h-6 rounded-full bg-success/10 flex items-center justify-center">
                      <Check size={14} className="text-success" />
                    </div>
                  ) : i === creationSteps.findIndex(x => !x.done) ? (
                    <Loader2 size={18} className="animate-spin text-primary" />
                  ) : (
                    <div className="w-6 h-6 rounded-full bg-surface-alt" />
                  )}
                  <span className={`text-sm ${s.done ? "text-text" : "text-text-secondary"}`}>
                    {s.label}
                  </span>
                </div>
              ))}
            </div>

            {error && (
              <div className="mt-6">
                <p className="text-sm text-danger bg-danger-light px-3 py-2 rounded-lg mb-3">{error}</p>
                <Button size="sm" onClick={() => { setStep(2); setCreating(false); }}>
                  Try again
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Skip link */}
        {step !== 3 && (
          <p className="text-center mt-6">
            <button
              onClick={() => {
                api.post("/org/settings", { onboarding_complete: true }).catch(() => {});
                navigate("/dashboard");
              }}
              className="text-xs text-text-muted hover:text-text-secondary"
            >
              Skip for now — I'll explore on my own
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
