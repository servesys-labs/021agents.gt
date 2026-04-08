import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  FlaskConical,
  Globe,
  MessageCircle,
  Plus,
  Search,
  Settings,
  Shield,
} from "lucide-react";

/* ── Component ──────────────────────────────────────────────────── */

export function SuccessPage() {
  const { name: agentName } = useParams<{ name: string }>();
  const navigate = useNavigate();

  const prodWorkerBase = "https://runtime.oneshots.co";
  const restUrl = `${prodWorkerBase}/api/v1/agents/${agentName}/run`;

  const nextSteps = [
    {
      label: "Run Eval",
      description: "Test your agent against evaluation datasets",
      icon: FlaskConical,
      color: "text-chart-green bg-chart-green/10",
      path: `/agents/${agentName}?tab=eval`,
    },
    {
      label: "View Traces",
      description: "Inspect conversation turns and tool calls",
      icon: Search,
      color: "text-chart-blue bg-chart-blue/10",
      path: `/agents/${agentName}?tab=traces`,
    },
    {
      label: "Set up Monitoring",
      description: "Configure SLOs, alerts, and dashboards",
      icon: BarChart3,
      color: "text-chart-purple bg-chart-purple/10",
      path: `/agents/${agentName}?tab=slos`,
    },
    {
      label: "Security Scan",
      description: "Run prompt injection and jailbreak tests",
      icon: Shield,
      color: "text-chart-orange bg-chart-orange/10",
      path: `/agents/${agentName}?tab=security`,
    },
    {
      label: "Add to Project",
      description: "Organize agents into projects and environments",
      icon: Settings,
      color: "text-chart-cyan bg-chart-cyan/10",
      path: "/settings?tab=projects",
    },
    {
      label: "Create Another",
      description: "Build a new agent from description",
      icon: Plus,
      color: "text-accent bg-accent-muted",
      path: "/",
    },
  ];

  return (
    <div className="max-w-2xl mx-auto flex flex-col items-center pt-[var(--space-12)]">
      {/* Success icon */}
      <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-status-live/10 border-2 border-status-live/20 mb-[var(--space-6)]">
        <CheckCircle2 size={40} className="text-status-live" />
      </div>

      {/* Title */}
      <h1 className="text-[var(--text-xl)] font-bold text-text-primary mb-[var(--space-2)]">
        Agent deployed
      </h1>
      <p className="text-[var(--text-md)] text-text-secondary mb-[var(--space-8)] text-center leading-relaxed">
        <span className="font-semibold text-text-primary">{agentName}</span> is now live and accepting requests.
      </p>

      {/* Active channels */}
      <div className="w-full card mb-[var(--space-8)]">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Active Channels
        </h2>
        <div className="space-y-[var(--space-2)]">
          <div className="flex items-center gap-[var(--space-3)] p-[var(--space-2)]">
            <Globe size={16} className="text-accent flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[var(--text-sm)] text-text-primary">REST API</p>
              <p className="text-[var(--text-xs)] text-text-muted font-mono truncate">{restUrl}</p>
            </div>
            <span className="badge-live">LIVE</span>
          </div>

          <div className="flex items-center gap-[var(--space-3)] p-[var(--space-2)]">
            <MessageCircle size={16} className="text-status-info flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[var(--text-sm)] text-text-primary">WebSocket</p>
              <p className="text-[var(--text-xs)] text-text-muted font-mono truncate">
                wss://runtime.oneshots.co/agents/agentos-agent/{agentName}
              </p>
            </div>
            <span className="badge-live">LIVE</span>
          </div>
        </div>
      </div>

      {/* What's next grid */}
      <div className="w-full">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          What's next?
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[var(--space-3)]">
          {nextSteps.map((step) => (
            <button
              key={step.label}
              onClick={() => navigate(step.path)}
              className="card card-hover text-left p-[var(--space-4)] group cursor-pointer transition-all hover:border-accent/30"
            >
              <div className={`p-2 rounded-lg ${step.color} inline-flex mb-[var(--space-3)]`}>
                <step.icon size={18} />
              </div>
              <p className="text-[var(--text-sm)] font-medium text-text-primary group-hover:text-accent transition-colors flex items-center gap-[var(--space-1)]">
                {step.label}
                <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </p>
              <p className="text-[var(--text-xs)] text-text-muted mt-[var(--space-1)] leading-relaxed">
                {step.description}
              </p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export { SuccessPage as default };
