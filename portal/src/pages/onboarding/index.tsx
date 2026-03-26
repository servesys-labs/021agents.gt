import { useState, useMemo, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ArrowRight, Bot, SkipForward } from "lucide-react";
import { apiPost } from "../../lib/api";
import { PageShell } from "../../components/layout/PageShell";

/* ── Tool catalog — top apps by category ────────────────────────── */

type AppDef = { slug: string; name: string };

const CATEGORIES: Array<{ id: string; label: string; apps: AppDef[] }> = [
  {
    id: "crm",
    label: "CRM & Sales",
    apps: [
      { slug: "hubspot", name: "HubSpot" },
      { slug: "salesforce", name: "Salesforce" },
      { slug: "pipedrive", name: "Pipedrive" },
      { slug: "close", name: "Close" },
      { slug: "apollo-io", name: "Apollo" },
    ],
  },
  {
    id: "email",
    label: "Email",
    apps: [
      { slug: "gmail", name: "Gmail" },
      { slug: "microsoft-outlook", name: "Outlook" },
      { slug: "sendgrid", name: "SendGrid" },
      { slug: "mailchimp", name: "Mailchimp" },
      { slug: "resend", name: "Resend" },
    ],
  },
  {
    id: "chat",
    label: "Chat & Messaging",
    apps: [
      { slug: "slack", name: "Slack" },
      { slug: "microsoft-teams", name: "Teams" },
      { slug: "discord", name: "Discord" },
      { slug: "intercom", name: "Intercom" },
      { slug: "twilio", name: "Twilio" },
    ],
  },
  {
    id: "calendar",
    label: "Calendar & Scheduling",
    apps: [
      { slug: "google-calendar", name: "Google Calendar" },
      { slug: "calendly", name: "Calendly" },
      { slug: "cal-com", name: "Cal.com" },
      { slug: "microsoft-outlook", name: "Outlook Calendar" },
    ],
  },
  {
    id: "pm",
    label: "Project Management",
    apps: [
      { slug: "jira", name: "Jira" },
      { slug: "linear", name: "Linear" },
      { slug: "asana", name: "Asana" },
      { slug: "notion", name: "Notion" },
      { slug: "trello", name: "Trello" },
      { slug: "monday", name: "Monday.com" },
    ],
  },
  {
    id: "devops",
    label: "DevOps & Engineering",
    apps: [
      { slug: "github", name: "GitHub" },
      { slug: "gitlab", name: "GitLab" },
      { slug: "datadog", name: "Datadog" },
      { slug: "pagerduty", name: "PagerDuty" },
      { slug: "sentry", name: "Sentry" },
    ],
  },
  {
    id: "payments",
    label: "Payments & Finance",
    apps: [
      { slug: "stripe", name: "Stripe" },
      { slug: "quickbooks", name: "QuickBooks" },
      { slug: "xero", name: "Xero" },
      { slug: "square", name: "Square" },
    ],
  },
  {
    id: "marketing",
    label: "Marketing & Social",
    apps: [
      { slug: "linkedin", name: "LinkedIn" },
      { slug: "twitter", name: "Twitter / X" },
      { slug: "facebook-pages", name: "Facebook" },
      { slug: "google-ads", name: "Google Ads" },
      { slug: "mailchimp", name: "Mailchimp" },
    ],
  },
  {
    id: "support",
    label: "Customer Support",
    apps: [
      { slug: "zendesk", name: "Zendesk" },
      { slug: "freshdesk", name: "Freshdesk" },
      { slug: "help-scout", name: "Help Scout" },
      { slug: "intercom", name: "Intercom" },
    ],
  },
  {
    id: "storage",
    label: "Data & Storage",
    apps: [
      { slug: "google-sheets", name: "Google Sheets" },
      { slug: "airtable", name: "Airtable" },
      { slug: "google-drive", name: "Google Drive" },
      { slug: "dropbox", name: "Dropbox" },
      { slug: "notion", name: "Notion" },
    ],
  },
];

/* ── Component ──────────────────────────────────────────────────── */

export function OnboardingPage() {
  const navigate = useNavigate();
  const [orgName, setOrgName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Categories that have at least one selection collapse
  const satisfiedCategories = useMemo(() => {
    const satisfied = new Set<string>();
    for (const cat of CATEGORIES) {
      if (cat.apps.some((app) => selected.has(app.slug))) {
        satisfied.add(cat.id);
      }
    }
    return satisfied;
  }, [selected]);

  // Show unsatisfied categories first, then satisfied (collapsed)
  const sortedCategories = useMemo(() => {
    const unsatisfied = CATEGORIES.filter((c) => !satisfiedCategories.has(c.id));
    const satisfied = CATEGORIES.filter((c) => satisfiedCategories.has(c.id));
    return [...unsatisfied, ...satisfied];
  }, [satisfiedCategories]);

  const toggleApp = (slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const handleContinue = async () => {
    setSaving(true);
    try {
      await apiPost("/api/v1/org/settings", {
        org_name: orgName.trim() || undefined,
        default_connectors: [...selected],
        onboarding_complete: true,
      });
    } catch {
      // Save failed — still proceed, preferences can be set later
    }
    setSaving(false);
    navigate("/");
  };

  const handleSkip = async () => {
    try {
      await apiPost("/api/v1/org/settings", { onboarding_complete: true });
    } catch {
      // Proceed anyway
    }
    navigate("/");
  };

  return (
    <PageShell variant="centered">
      <div className="w-full max-w-4xl">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-2xl bg-accent/15 flex items-center justify-center mx-auto mb-4">
            <Bot size={24} className="text-accent" />
          </div>
          <h1 className="text-xl font-bold text-text-primary mb-2">
            Welcome to AgentOS
          </h1>
          <p className="text-sm text-text-secondary max-w-lg mx-auto">
            What tools does your team use? We'll configure your agents to work with them out of the box.
          </p>
        </div>

        {/* Org name */}
        <div className="card mb-6">
          <label className="text-label text-text-muted mb-2 block">Organization Name</label>
          <input
            type="text"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="e.g., Acme Inc."
            className="text-sm max-w-md"
          />
          <p className="text-hint mt-1.5">This is how your workspace will appear across AgentOS.</p>
        </div>

        {/* Category grid */}
        <div className="space-y-4 mb-8">
          {sortedCategories.map((cat, catIdx) => {
            const isSatisfied = satisfiedCategories.has(cat.id);
            const selectedInCat = cat.apps.filter((a) => selected.has(a.slug));

            return (
              <div
                key={cat.id}
                className="card stagger-item"
                style={{ "--stagger-index": catIdx } as CSSProperties}
              >
                <div className="flex items-center justify-between mb-3">
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

                {/* Show apps — collapsed if satisfied, expanded otherwise */}
                <div
                  className="grid transition-all duration-200 ease-out"
                  style={{
                    gridTemplateRows: isSatisfied ? "0fr" : "1fr",
                    opacity: isSatisfied ? 0 : 1,
                  }}
                >
                  <div className="overflow-hidden">
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                      {cat.apps.map((app) => {
                        const isSelected = selected.has(app.slug);
                        return (
                          <button
                            key={`${cat.id}-${app.slug}`}
                            onClick={() => toggleApp(app.slug)}
                            className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                              isSelected
                                ? "bg-accent/10 border-accent/40 text-accent"
                                : "bg-surface-base border-border-default text-text-secondary hover:border-accent/20 hover:text-text-primary"
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

        {/* Actions */}
        <div className="flex items-center justify-between">
          <button
            onClick={handleSkip}
            className="btn btn-ghost text-xs text-text-muted"
          >
            <SkipForward size={14} />
            Skip for now
          </button>

          <div className="flex items-center gap-3">
            {selected.size > 0 && (
              <span className="text-xs text-text-muted">
                {selected.size} tool{selected.size !== 1 ? "s" : ""} selected
              </span>
            )}
            <button
              onClick={handleContinue}
              disabled={saving}
              className="btn btn-primary"
            >
              {saving ? "Saving..." : selected.size > 0 ? "Continue" : "Continue without tools"}
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </PageShell>
  );
}

export default OnboardingPage;
