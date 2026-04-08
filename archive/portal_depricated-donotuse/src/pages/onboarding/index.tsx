import { useState, useMemo, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ArrowRight, ArrowLeft, Bot, SkipForward } from "lucide-react";
import { apiPost } from "../../lib/api";
import { PageShell } from "../../components/layout/PageShell";

/* ── Step definitions ───────────────────────────────────────────── */

const INDUSTRIES = [
  "SaaS / Software",
  "E-commerce / Retail",
  "Agency / Consulting",
  "Finance / Fintech",
  "Healthcare",
  "Education",
  "Media / Content",
  "Manufacturing",
  "Real Estate",
  "Other",
];

const TEAM_SIZES = [
  { value: "solo", label: "Just me" },
  { value: "small", label: "2-10 people" },
  { value: "medium", label: "11-50 people" },
  { value: "large", label: "51-200 people" },
  { value: "enterprise", label: "200+ people" },
];

const USE_CASES = [
  "Customer Support",
  "Sales & Marketing",
  "Software Engineering",
  "Data & Analytics",
  "Operations & Automation",
  "Research & Knowledge",
  "Content Creation",
  "HR & Recruiting",
];

const DATA_SENSITIVITY = [
  { value: "standard", label: "Standard", desc: "No special compliance requirements" },
  { value: "pii", label: "Handles PII", desc: "Names, emails, phone numbers" },
  { value: "financial", label: "Financial data", desc: "Payment info, billing, PCI scope" },
  { value: "health", label: "Health data", desc: "HIPAA-regulated information" },
  { value: "regulated", label: "Highly regulated", desc: "SOC2, ISO 27001, or similar" },
];

const DEPLOY_STYLE = [
  { value: "fast", label: "Move fast", desc: "Deploy directly, iterate quickly" },
  { value: "balanced", label: "Balanced", desc: "Staging first, then promote" },
  { value: "careful", label: "Careful review", desc: "Staging → canary → approval gates" },
];

const PLANS = [
  {
    value: "free",
    label: "Free",
    price: "$0/mo",
    desc: "Explore the platform with free models",
    model: "@cf/moonshotai/kimi-k2.5",
    features: ["1 agent", "Free model (Kimi K2.5)", "100 runs/month", "Community support"],
  },
  {
    value: "starter",
    label: "Starter",
    price: "$29/mo",
    desc: "For individuals and small projects",
    model: "anthropic/claude-haiku-4-5",
    features: ["5 agents", "Claude Haiku 4.5", "1,000 runs/month", "Email support"],
  },
  {
    value: "professional",
    label: "Professional",
    price: "$99/mo",
    desc: "For teams building production agents",
    model: "anthropic/claude-sonnet-4-6",
    popular: true,
    features: ["25 agents", "Claude Sonnet 4.6", "10,000 runs/month", "Sub-agents & workflows", "Priority support"],
  },
  {
    value: "enterprise",
    label: "Enterprise",
    price: "Custom",
    desc: "For organizations with advanced needs",
    model: "anthropic/claude-sonnet-4-6",
    features: ["Unlimited agents", "All models", "Unlimited runs", "SSO & RBAC", "Dedicated support", "Custom SLAs"],
  },
];

/* ── Tool catalog ───────────────────────────────────────────────── */

type AppDef = { slug: string; name: string };

const CATEGORIES: Array<{ id: string; label: string; apps: AppDef[] }> = [
  {
    id: "crm", label: "CRM & Sales",
    apps: [
      { slug: "hubspot", name: "HubSpot" }, { slug: "salesforce", name: "Salesforce" },
      { slug: "pipedrive", name: "Pipedrive" }, { slug: "close", name: "Close" }, { slug: "apollo-io", name: "Apollo" },
    ],
  },
  {
    id: "email", label: "Email",
    apps: [
      { slug: "gmail", name: "Gmail" }, { slug: "microsoft-outlook", name: "Outlook" },
      { slug: "sendgrid", name: "SendGrid" }, { slug: "mailchimp", name: "Mailchimp" }, { slug: "resend", name: "Resend" },
    ],
  },
  {
    id: "chat", label: "Chat & Messaging",
    apps: [
      { slug: "slack", name: "Slack" }, { slug: "microsoft-teams", name: "Teams" },
      { slug: "discord", name: "Discord" }, { slug: "intercom", name: "Intercom" }, { slug: "twilio", name: "Twilio" },
    ],
  },
  {
    id: "calendar", label: "Calendar & Scheduling",
    apps: [
      { slug: "google-calendar", name: "Google Calendar" }, { slug: "calendly", name: "Calendly" },
      { slug: "cal-com", name: "Cal.com" },
    ],
  },
  {
    id: "pm", label: "Project Management",
    apps: [
      { slug: "jira", name: "Jira" }, { slug: "linear", name: "Linear" }, { slug: "asana", name: "Asana" },
      { slug: "notion", name: "Notion" }, { slug: "trello", name: "Trello" },
    ],
  },
  {
    id: "devops", label: "DevOps & Engineering",
    apps: [
      { slug: "github", name: "GitHub" }, { slug: "gitlab", name: "GitLab" },
      { slug: "datadog", name: "Datadog" }, { slug: "pagerduty", name: "PagerDuty" }, { slug: "sentry", name: "Sentry" },
    ],
  },
  {
    id: "payments", label: "Payments & Finance",
    apps: [
      { slug: "stripe", name: "Stripe" }, { slug: "quickbooks", name: "QuickBooks" },
      { slug: "xero", name: "Xero" }, { slug: "square", name: "Square" },
    ],
  },
  {
    id: "marketing", label: "Marketing & Social",
    apps: [
      { slug: "linkedin", name: "LinkedIn" }, { slug: "twitter", name: "Twitter / X" },
      { slug: "facebook-pages", name: "Facebook" }, { slug: "google-ads", name: "Google Ads" },
    ],
  },
  {
    id: "support", label: "Customer Support",
    apps: [
      { slug: "zendesk", name: "Zendesk" }, { slug: "freshdesk", name: "Freshdesk" },
      { slug: "help-scout", name: "Help Scout" },
    ],
  },
  {
    id: "storage", label: "Data & Storage",
    apps: [
      { slug: "google-sheets", name: "Google Sheets" }, { slug: "airtable", name: "Airtable" },
      { slug: "google-drive", name: "Google Drive" }, { slug: "dropbox", name: "Dropbox" },
    ],
  },
];

/* ── Component ──────────────────────────────────────────────────── */

export function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  // Step 1: Org profile
  const [orgName, setOrgName] = useState("");
  const [industry, setIndustry] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [useCases, setUseCases] = useState<Set<string>>(new Set());

  // Step 2: Preferences
  const [dataSensitivity, setDataSensitivity] = useState("standard");
  const [deployStyle, setDeployStyle] = useState("balanced");
  const [selectedPlan, setSelectedPlan] = useState("professional");

  // Step 3: Tools
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());

  const toggleUseCase = (uc: string) => {
    setUseCases((prev) => {
      const next = new Set(prev);
      if (next.has(uc)) next.delete(uc); else next.add(uc);
      return next;
    });
  };

  const toggleTool = (slug: string) => {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });
  };

  const satisfiedCategories = useMemo(() => {
    const satisfied = new Set<string>();
    for (const cat of CATEGORIES) {
      if (cat.apps.some((app) => selectedTools.has(app.slug))) satisfied.add(cat.id);
    }
    return satisfied;
  }, [selectedTools]);

  const sortedCategories = useMemo(() => {
    const unsatisfied = CATEGORIES.filter((c) => !satisfiedCategories.has(c.id));
    const satisfied = CATEGORIES.filter((c) => satisfiedCategories.has(c.id));
    return [...unsatisfied, ...satisfied];
  }, [satisfiedCategories]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const plan = PLANS.find((p) => p.value === selectedPlan);
      await apiPost("/api/v1/org/settings", {
        org_name: orgName.trim() || undefined,
        industry,
        team_size: teamSize,
        use_cases: [...useCases],
        data_sensitivity: dataSensitivity,
        deploy_style: deployStyle,
        plan: selectedPlan,
        default_model: plan?.model ?? "anthropic/claude-sonnet-4-6",
        default_connectors: [...selectedTools],
        onboarding_complete: true,
      });
    } catch {
      // Proceed anyway
    }
    setSaving(false);
    navigate("/");
  };

  const handleSkip = async () => {
    try {
      await apiPost("/api/v1/org/settings", { onboarding_complete: true });
    } catch {}
    navigate("/");
  };

  const STEPS = ["Your Organization", "Preferences", "Integrations"];

  return (
    <PageShell variant="centered">
      <div className="w-full max-w-3xl">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-11 h-11 rounded-xl bg-accent/15 flex items-center justify-center mx-auto mb-3">
            <Bot size={22} className="text-accent" />
          </div>
          <h1 className="text-lg font-bold text-text-primary mb-1">
            Set up your workspace
          </h1>
          <p className="text-sm text-text-muted">
            This takes 30 seconds and makes every agent you create smarter.
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <button
                onClick={() => setStep(i)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  i === step
                    ? "bg-accent text-white"
                    : i < step
                      ? "bg-accent/15 text-accent"
                      : "bg-surface-overlay text-text-muted"
                }`}
              >
                {i < step ? <Check size={12} /> : <span>{i + 1}</span>}
                {label}
              </button>
              {i < STEPS.length - 1 && <div className="w-6 h-px bg-border-default" />}
            </div>
          ))}
        </div>

        {/* Step 1: Org Profile */}
        {step === 0 && (
          <div className="space-y-5">
            <div className="card">
              <label className="text-label text-text-muted mb-2 block">Organization Name</label>
              <input type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="e.g., Acme Inc." className="text-sm max-w-md" />
            </div>

            <div className="card">
              <label className="text-label text-text-muted mb-3 block">Industry</label>
              <div className="flex flex-wrap gap-2">
                {INDUSTRIES.map((ind) => (
                  <button
                    key={ind}
                    onClick={() => setIndustry(ind)}
                    className={`px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                      industry === ind
                        ? "bg-accent/10 border-accent/40 text-accent"
                        : "bg-surface-base border-border-default text-text-secondary hover:border-accent/20"
                    }`}
                  >
                    {industry === ind && <Check size={12} className="inline mr-1" />}
                    {ind}
                  </button>
                ))}
              </div>
            </div>

            <div className="card">
              <label className="text-label text-text-muted mb-3 block">Team Size</label>
              <div className="flex flex-wrap gap-2">
                {TEAM_SIZES.map((ts) => (
                  <button
                    key={ts.value}
                    onClick={() => setTeamSize(ts.value)}
                    className={`px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                      teamSize === ts.value
                        ? "bg-accent/10 border-accent/40 text-accent"
                        : "bg-surface-base border-border-default text-text-secondary hover:border-accent/20"
                    }`}
                  >
                    {teamSize === ts.value && <Check size={12} className="inline mr-1" />}
                    {ts.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="card">
              <label className="text-label text-text-muted mb-3 block">Primary Use Cases (select all that apply)</label>
              <div className="flex flex-wrap gap-2">
                {USE_CASES.map((uc) => (
                  <button
                    key={uc}
                    onClick={() => toggleUseCase(uc)}
                    className={`px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                      useCases.has(uc)
                        ? "bg-accent/10 border-accent/40 text-accent"
                        : "bg-surface-base border-border-default text-text-secondary hover:border-accent/20"
                    }`}
                  >
                    {useCases.has(uc) && <Check size={12} className="inline mr-1" />}
                    {uc}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Preferences */}
        {step === 1 && (
          <div className="space-y-5">
            <div className="card">
              <label className="text-label text-text-muted mb-3 block">Data Sensitivity</label>
              <p className="text-hint mb-3">This sets default guardrails and compliance policies for your agents.</p>
              <div className="space-y-2">
                {DATA_SENSITIVITY.map((ds) => (
                  <button
                    key={ds.value}
                    onClick={() => setDataSensitivity(ds.value)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-all ${
                      dataSensitivity === ds.value
                        ? "bg-accent/10 border-accent/40"
                        : "bg-surface-base border-border-default hover:border-accent/20"
                    }`}
                  >
                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                      dataSensitivity === ds.value ? "border-accent" : "border-border-strong"
                    }`}>
                      {dataSensitivity === ds.value && <div className="w-2 h-2 rounded-full bg-accent" />}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-text-primary">{ds.label}</p>
                      <p className="text-xs text-text-muted">{ds.desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="card">
              <label className="text-label text-text-muted mb-3 block">Deployment Style</label>
              <p className="text-hint mb-3">How carefully should agents be deployed to production?</p>
              <div className="space-y-2">
                {DEPLOY_STYLE.map((ds) => (
                  <button
                    key={ds.value}
                    onClick={() => setDeployStyle(ds.value)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-all ${
                      deployStyle === ds.value
                        ? "bg-accent/10 border-accent/40"
                        : "bg-surface-base border-border-default hover:border-accent/20"
                    }`}
                  >
                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                      deployStyle === ds.value ? "border-accent" : "border-border-strong"
                    }`}>
                      {deployStyle === ds.value && <div className="w-2 h-2 rounded-full bg-accent" />}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-text-primary">{ds.label}</p>
                      <p className="text-xs text-text-muted">{ds.desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="card">
              <label className="text-label text-text-muted mb-3 block">Choose a Plan</label>
              <p className="text-hint mb-3">Determines your default model, agent limits, and features. You can upgrade anytime.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {PLANS.map((plan) => (
                  <button
                    key={plan.value}
                    onClick={() => setSelectedPlan(plan.value)}
                    className={`relative flex flex-col p-4 rounded-xl border text-left transition-all ${
                      selectedPlan === plan.value
                        ? "bg-accent/10 border-accent/40 ring-1 ring-accent/30"
                        : "bg-surface-base border-border-default hover:border-accent/20"
                    }`}
                  >
                    {plan.popular && (
                      <span className="absolute -top-2 right-3 px-2 py-0.5 text-[9px] font-bold bg-accent text-white rounded-full">
                        Popular
                      </span>
                    )}
                    <div className="flex items-baseline justify-between mb-2">
                      <span className="text-sm font-bold text-text-primary">{plan.label}</span>
                      <span className="text-sm font-bold text-accent">{plan.price}</span>
                    </div>
                    <p className="text-xs text-text-muted mb-3">{plan.desc}</p>
                    <ul className="space-y-1">
                      {plan.features.map((f) => (
                        <li key={f} className="flex items-center gap-1.5 text-xs text-text-secondary">
                          <Check size={10} className="text-status-live flex-shrink-0" /> {f}
                        </li>
                      ))}
                    </ul>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Tool selection */}
        {step === 2 && (
          <div className="space-y-3">
            <p className="text-sm text-text-muted mb-2">
              Select the tools your team uses. Agents will default to these integrations.
            </p>
            {sortedCategories.map((cat, catIdx) => {
              const isSatisfied = satisfiedCategories.has(cat.id);
              const selectedInCat = cat.apps.filter((a) => selectedTools.has(a.slug));

              return (
                <div key={cat.id} className="card stagger-item" style={{ "--stagger-index": catIdx } as CSSProperties}>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-text-primary">{cat.label}</h3>
                    {isSatisfied && (
                      <div className="flex items-center gap-1.5">
                        <Check size={12} className="text-status-live" />
                        <span className="text-[10px] text-status-live font-medium">
                          {selectedInCat.map((a) => a.name).join(", ")}
                        </span>
                      </div>
                    )}
                  </div>
                  <div
                    className="grid transition-all duration-200 ease-out"
                    style={{ gridTemplateRows: isSatisfied ? "0fr" : "1fr", opacity: isSatisfied ? 0 : 1 }}
                  >
                    <div className="overflow-hidden">
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                        {cat.apps.map((app) => {
                          const isSelected = selectedTools.has(app.slug);
                          return (
                            <button
                              key={`${cat.id}-${app.slug}`}
                              onClick={() => toggleTool(app.slug)}
                              className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                                isSelected
                                  ? "bg-accent/10 border-accent/40 text-accent"
                                  : "bg-surface-base border-border-default text-text-secondary hover:border-accent/20"
                              }`}
                            >
                              {isSelected && <Check size={14} />}
                              {app.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between mt-6">
          <div>
            {step === 0 ? (
              <button onClick={handleSkip} className="btn btn-ghost text-xs text-text-muted">
                <SkipForward size={14} /> Skip setup
              </button>
            ) : (
              <button onClick={() => setStep(step - 1)} className="btn btn-ghost text-xs">
                <ArrowLeft size={14} /> Back
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {step === 2 && selectedTools.size > 0 && (
              <span className="text-xs text-text-muted">{selectedTools.size} tools selected</span>
            )}
            {step < 2 ? (
              <button onClick={() => setStep(step + 1)} className="btn btn-primary">
                Next <ArrowRight size={14} />
              </button>
            ) : (
              <button onClick={handleSave} disabled={saving} className="btn btn-primary">
                {saving ? "Setting up..." : "Launch AgentOS"} <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </PageShell>
  );
}

export default OnboardingPage;
