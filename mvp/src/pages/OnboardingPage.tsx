import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { StepWizard } from "../components/StepWizard";
import { api } from "../lib/api";
import { PRODUCT } from "../lib/product";
import { Mail, Calendar, CreditCard, MessageSquare, Table, Users, Phone, Camera, Loader2, AlertCircle, Briefcase, User, Send, Hash } from "lucide-react";

const iconMap: Record<string, React.ComponentType<any>> = {
  Mail, Calendar, CreditCard, MessageSquare, Table, Users, Phone, Camera,
};

const INDUSTRIES = [
  "Retail / E-commerce",
  "Food & Beverage",
  "Health & Wellness",
  "Professional Services",
  "Real Estate",
  "Education",
  "Home Services",
  "Automotive",
  "Travel & Hospitality",
  "Other",
];

const USE_CASES = [
  { id: "customer_support", label: "Customer Support", description: "Answer questions, resolve issues, handle FAQs" },
  { id: "sales", label: "Sales & Lead Qualification", description: "Qualify leads, book meetings, follow up on inquiries" },
  { id: "scheduling", label: "Scheduling & Bookings", description: "Handle appointments, reservations, and calendar management" },
  { id: "order_management", label: "Order Management", description: "Track orders, process returns, update delivery status" },
  { id: "onboarding", label: "Client Onboarding", description: "Guide new customers through setup and first steps" },
  { id: "custom", label: "Custom", description: "Build a custom agent from scratch" },
];

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

const PERSONAL_HELP = [
  { id: "tasks_reminders", label: "Tasks & reminders", description: "To-dos, follow-ups, and nudges" },
  { id: "calendar_email", label: "Calendar & email triage", description: "Scheduling and inbox summaries" },
  { id: "research", label: "Research & reading", description: "Look things up and condense articles" },
  { id: "notes", label: "Notes & capture", description: "Quick memos and idea capture" },
  { id: "travel_home", label: "Travel & life admin", description: "Bookings, lists, and errands" },
];

const CHAT_APPS: { id: string; label: string; description: string; Icon: React.ComponentType<any> }[] = [
  { id: "telegram", label: "Telegram", description: "DM your assistant from Telegram", Icon: Send },
  { id: "whatsapp", label: "WhatsApp", description: "Chat on WhatsApp Business / API", Icon: Phone },
  { id: "slack", label: "Slack", description: "A DM or channel in your workspace", Icon: Hash },
];

type Path = "choose" | "business" | "personal";

export default function OnboardingPage() {
  const [path, setPath] = useState<Path>("choose");
  const [step, setStep] = useState(0);
  const navigate = useNavigate();

  const [bizName, setBizName] = useState("");
  const [industry, setIndustry] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [selectedUseCases, setSelectedUseCases] = useState<string[]>([]);
  const [connectedTools, setConnectedTools] = useState<string[]>([]);

  const [assistantName, setAssistantName] = useState("");
  const [yourName, setYourName] = useState("");
  const [personalHelp, setPersonalHelp] = useState<string[]>([]);
  const [chatApps, setChatApps] = useState<string[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const businessSteps = ["Your Business", "Use Case", "Connect Tools"];
  const personalSteps = ["You & name", "Daily help", "Chat apps"];

  const toggleUseCaseFixed = (id: string) =>
    setSelectedUseCases((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const toggleTool = (id: string) =>
    setConnectedTools((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const togglePersonalHelp = (id: string) =>
    setPersonalHelp((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const toggleChatApp = (id: string) =>
    setChatApps((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const completeBusiness = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.post("/orgs/settings", {
        workspace_mode: "business",
        business_name: bizName,
        industry,
        team_size: teamSize,
        use_cases: selectedUseCases,
        connected_tools: connectedTools,
        onboarding_complete: true,
      });

      // Create a default starter agent based on the user's business context
      const agentName = `${(bizName || "my").toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 20)}-assistant`;
      const description = `AI assistant for ${bizName || "your business"}${industry ? ` in ${industry}` : ""}. Helps with: ${selectedUseCases.join(", ") || "general tasks"}.`;
      try {
        const result = await api.post<{ name?: string; agent_id?: string }>("/agents/create-from-description", {
          name: agentName,
          description,
          plan: "standard",
          tools: "auto",
          auto_graph: true,
        });
        // Navigate directly to the new agent's playground
        navigate(`/agents/${result.name || agentName}/play`);
      } catch {
        // If agent creation fails, still navigate to dashboard
        navigate("/");
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSubmitting(false);
    }
  };

  const completePersonal = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.post("/orgs/settings", {
        workspace_mode: "personal",
        owner_display_name: yourName,
        suggested_assistant_name: assistantName,
        personal_help_areas: personalHelp,
        preferred_chat_channels: chatApps,
        onboarding_complete: true,
      });
      navigate("/agents/new", {
        state: {
          personalFlow: true,
          preferredChat: chatApps,
          suggestedName: assistantName.trim() || "My assistant",
          personalHelp,
        },
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSubmitting(false);
    }
  };

  if (path === "choose") {
    return (
      <div className="min-h-screen bg-surface-alt flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-lg">
          <h1 className="text-2xl font-semibold text-text text-center mb-2 tracking-tight">{PRODUCT.onboardingHeadline}</h1>
          <p className="text-text-secondary text-center mb-8 text-sm">{PRODUCT.onboardingSub}</p>

          <div className="space-y-4">
            <button
              type="button"
              onClick={() => {
                setPath("business");
                setStep(0);
              }}
              className="w-full text-left rounded-xl border border-border bg-surface p-5 shadow-sm hover:border-primary/40 hover:shadow-md transition-all focus:outline-none focus:ring-2 focus:ring-primary/25"
            >
              <div className="flex items-start gap-4">
                <div className="w-11 h-11 rounded-lg bg-primary-light flex items-center justify-center shrink-0">
                  <Briefcase className="text-primary" size={22} />
                </div>
                <div>
                  <p className="font-semibold text-text">For my business</p>
                  <p className="text-sm text-text-secondary mt-1 leading-relaxed">
                    Customer-facing assistants: website, orders, leads, and support.
                  </p>
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setPath("personal");
                setStep(0);
              }}
              className="w-full text-left rounded-xl border border-border bg-surface p-5 shadow-sm hover:border-primary/40 hover:shadow-md transition-all focus:outline-none focus:ring-2 focus:ring-primary/25"
            >
              <div className="flex items-start gap-4">
                <div className="w-11 h-11 rounded-lg bg-violet-100 flex items-center justify-center shrink-0">
                  <User className="text-violet-600" size={22} />
                </div>
                <div>
                  <p className="font-semibold text-text">Personal assistant</p>
                  <p className="text-sm text-text-secondary mt-1 leading-relaxed">
                    {PRODUCT.onboardingPersonalSub}
                  </p>
                </div>
              </div>
            </button>
          </div>

          <p className="text-center mt-8">
            <Button variant="ghost" onClick={() => navigate("/agents/new")}>
              Skip — create an assistant now
            </Button>
          </p>
        </div>
      </div>
    );
  }

  if (path === "personal") {
    return (
      <div className="min-h-screen bg-surface-alt flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-lg">
          <h1 className="text-2xl font-semibold text-text text-center mb-2 tracking-tight">{PRODUCT.onboardingPersonalHeadline}</h1>
          <p className="text-text-secondary text-center mb-8 text-sm max-w-md mx-auto leading-relaxed">{PRODUCT.onboardingPersonalSub}</p>

          <div className="bg-surface rounded-xl border border-border p-6 shadow-sm">
            <StepWizard steps={personalSteps} currentStep={step}>
              {step === 0 && (
                <div className="space-y-4">
                  <Input
                    label="Assistant name"
                    placeholder="e.g. Sidekick, Alex, Home"
                    value={assistantName}
                    onChange={(e) => setAssistantName(e.target.value)}
                  />
                  <Input label="Your name (optional)" placeholder="How it should address you" value={yourName} onChange={(e) => setYourName(e.target.value)} />
                  <div className="flex justify-between pt-4">
                    <Button variant="ghost" onClick={() => { setPath("choose"); setStep(0); }}>Back</Button>
                    <Button onClick={() => setStep(1)} disabled={!assistantName.trim()}>
                      Continue
                    </Button>
                  </div>
                </div>
              )}

              {step === 1 && (
                <div className="space-y-3">
                  <p className="text-sm text-text-secondary mb-2">What should it help you with? Select all that apply.</p>
                  {PERSONAL_HELP.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => togglePersonalHelp(item.id)}
                      className={`w-full text-left p-4 rounded-lg border transition-colors ${
                        personalHelp.includes(item.id) ? "border-primary bg-primary-light" : "border-border hover:border-border"
                      }`}
                    >
                      <p className="text-sm font-medium text-text">{item.label}</p>
                      <p className="text-xs text-text-secondary mt-0.5">{item.description}</p>
                    </button>
                  ))}
                  <div className="flex justify-between pt-4">
                    <Button variant="ghost" onClick={() => setStep(0)}>Back</Button>
                    <Button onClick={() => setStep(2)}>Continue</Button>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div>
                  <p className="text-sm text-text-secondary mb-4">
                    Choose where you want to talk to it. After you create the assistant, open{" "}
                    <strong>Channels</strong> to scan QR codes and paste bot links (Telegram / WhatsApp / Slack).
                  </p>
                  <div className="space-y-2">
                    {CHAT_APPS.map(({ id, label, description, Icon }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => toggleChatApp(id)}
                        className={`w-full flex items-center gap-3 p-4 rounded-lg border text-left transition-colors ${
                          chatApps.includes(id) ? "border-primary bg-primary-light" : "border-border hover:border-border"
                        }`}
                      >
                        <Icon size={20} className="text-text-secondary shrink-0" />
                        <div>
                          <p className="text-sm font-medium text-text">{label}</p>
                          <p className="text-xs text-text-secondary">{description}</p>
                        </div>
                      </button>
                    ))}
                  </div>

                  {submitError && (
                    <div className="flex items-center gap-2 p-3 mt-4 rounded-lg bg-danger-light border border-danger text-sm text-danger">
                      <AlertCircle size={16} className="shrink-0" />
                      <span>{submitError}</span>
                    </div>
                  )}

                  <div className="flex justify-between pt-6">
                    <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
                    <Button onClick={completePersonal} disabled={submitting}>
                      {submitting ? (
                        <>
                          <Loader2 size={14} className="animate-spin" /> Saving...
                        </>
                      ) : (
                        "Create personal assistant"
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </StepWizard>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-alt flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <h1 className="text-2xl font-semibold text-text text-center mb-2 tracking-tight">{PRODUCT.onboardingBusinessHeadline}</h1>
        <p className="text-text-secondary text-center mb-8 text-sm">{PRODUCT.onboardingBusinessSub}</p>

        <div className="bg-surface rounded-xl border border-border p-6 shadow-sm">
          <StepWizard steps={businessSteps} currentStep={step}>
            {step === 0 && (
              <div className="space-y-4">
                <Input label="Business name" placeholder="Sarah's Flower Shop" value={bizName} onChange={(e) => setBizName(e.target.value)} />
                <Select
                  label="Industry"
                  placeholder="Select your industry"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  options={INDUSTRIES.map((i) => ({ value: i, label: i }))}
                />
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-text">Team size</label>
                  <div className="grid grid-cols-3 gap-2">
                    {["Just me", "2-10", "11-50"].map((size) => (
                      <button
                        key={size}
                        type="button"
                        onClick={() => setTeamSize(size)}
                        className={`py-2 px-3 rounded-lg border text-sm font-medium transition-colors ${
                          teamSize === size
                            ? "border-primary bg-primary-light text-primary"
                            : "border-border text-text-secondary hover:border-border"
                        }`}
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex justify-between pt-4">
                  <Button variant="ghost" onClick={() => { setPath("choose"); setStep(0); }}>Back</Button>
                  <Button variant="ghost" onClick={() => navigate("/agents/new")}>Skip — go build an agent</Button>
                  <Button onClick={() => setStep(1)}>Continue</Button>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-3">
                <p className="text-sm text-text-secondary mb-4">What do you want your agent to help with? Select all that apply.</p>
                {USE_CASES.map((uc) => (
                  <button
                    key={uc.id}
                    type="button"
                    onClick={() => toggleUseCaseFixed(uc.id)}
                    className={`w-full text-left p-4 rounded-lg border transition-colors ${
                      selectedUseCases.includes(uc.id) ? "border-primary bg-primary-light" : "border-border hover:border-border"
                    }`}
                  >
                    <p className="text-sm font-medium text-text">{uc.label}</p>
                    <p className="text-xs text-text-secondary mt-0.5">{uc.description}</p>
                  </button>
                ))}
                <div className="flex justify-between pt-4">
                  <Button variant="ghost" onClick={() => setStep(0)}>Back</Button>
                  <Button onClick={() => setStep(2)}>Continue</Button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div>
                <p className="text-sm text-text-secondary mb-4">Connect the tools your agent will use. You can add more later.</p>
                <div className="grid grid-cols-2 gap-3">
                  {TOOLS.map((tool) => {
                    const Icon = iconMap[tool.icon];
                    const connected = connectedTools.includes(tool.id);
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() => toggleTool(tool.id)}
                        className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                          connected ? "border-primary bg-primary-light" : "border-border hover:border-border"
                        }`}
                      >
                        {Icon && <Icon size={18} />}
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-text">{tool.label}</p>
                          <p className="text-xs text-text-muted truncate">{tool.description}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {submitError && (
                  <div className="flex items-center gap-2 p-3 mt-4 rounded-lg bg-danger-light border border-danger text-sm text-danger">
                    <AlertCircle size={16} className="shrink-0" />
                    <span>{submitError}</span>
                  </div>
                )}

                <div className="flex justify-between pt-6">
                  <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
                  <Button onClick={completeBusiness} disabled={submitting}>
                    {submitting ? (
                      <>
                        <Loader2 size={14} className="animate-spin" /> Saving...
                      </>
                    ) : (
                      "Complete setup"
                    )}
                  </Button>
                </div>
              </div>
            )}
          </StepWizard>
        </div>
      </div>
    </div>
  );
}
