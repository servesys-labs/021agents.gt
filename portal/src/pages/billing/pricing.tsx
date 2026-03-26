import { useState } from "react";
import {
  CreditCard,
  Check,
  Zap,
  Building2,
  Sparkles,
  ArrowUpRight,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";

/* ── Types ──────────────────────────────────────────────────────── */

type PlanTier = "free" | "pro" | "enterprise";

interface PlanFeature {
  name: string;
  free: boolean | string;
  pro: boolean | string;
  enterprise: boolean | string;
}

interface PricingPlan {
  tier: PlanTier;
  name: string;
  price: string;
  period: string;
  description: string;
  icon: React.ReactNode;
  accentClass: string;
  glowClass: string;
  features: string[];
}

/* ── Data ───────────────────────────────────────────────────────── */

const CURRENT_PLAN: PlanTier = "free";

const plans: PricingPlan[] = [
  {
    tier: "free",
    name: "Free",
    price: "$0",
    period: "/month",
    description: "Get started with core agent capabilities",
    icon: <Sparkles size={20} />,
    accentClass: "text-chart-cyan",
    glowClass: "bg-node-glow-cyan",
    features: [
      "3 agents",
      "1,000 API calls/month",
      "100 MB storage",
      "Community support",
      "Basic analytics",
      "Single workspace",
    ],
  },
  {
    tier: "pro",
    name: "Pro",
    price: "$49",
    period: "/month",
    description: "Scale your agent operations with advanced features",
    icon: <Zap size={20} />,
    accentClass: "text-accent",
    glowClass: "bg-node-glow-orange",
    features: [
      "25 agents",
      "50,000 API calls/month",
      "10 GB storage",
      "Priority support",
      "Advanced analytics",
      "5 workspaces",
      "Custom guardrails",
      "A2A protocol access",
    ],
  },
  {
    tier: "enterprise",
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "Dedicated infrastructure for mission-critical workloads",
    icon: <Building2 size={20} />,
    accentClass: "text-chart-purple",
    glowClass: "bg-node-glow-purple",
    features: [
      "Unlimited agents",
      "Unlimited API calls",
      "Unlimited storage",
      "Dedicated support engineer",
      "Full observability suite",
      "Unlimited workspaces",
      "Custom guardrails",
      "A2A protocol access",
      "SSO & SCIM",
      "SLA guarantee",
      "On-premise deployment",
    ],
  },
];

const comparisonFeatures: PlanFeature[] = [
  { name: "Agents", free: "3", pro: "25", enterprise: "Unlimited" },
  { name: "API Calls / Month", free: "1,000", pro: "50,000", enterprise: "Unlimited" },
  { name: "Storage", free: "100 MB", pro: "10 GB", enterprise: "Unlimited" },
  { name: "Workspaces", free: "1", pro: "5", enterprise: "Unlimited" },
  { name: "Analytics", free: "Basic", pro: "Advanced", enterprise: "Full Suite" },
  { name: "Guardrails", free: false, pro: true, enterprise: true },
  { name: "A2A Protocol", free: false, pro: true, enterprise: true },
  { name: "Custom Pipelines", free: false, pro: true, enterprise: true },
  { name: "SSO & SCIM", free: false, pro: false, enterprise: true },
  { name: "SLA Guarantee", free: false, pro: false, enterprise: true },
  { name: "On-Premise Deployment", free: false, pro: false, enterprise: true },
  { name: "Dedicated Support", free: false, pro: false, enterprise: true },
];

/* ── Component ──────────────────────────────────────────────────── */

export function PricingPage() {
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("monthly");

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Pricing"
        subtitle="Choose the plan that fits your agent workload"
        icon={<CreditCard size={20} />}
      />

      {/* Billing toggle */}
      <div className="flex items-center justify-center gap-[var(--space-3)] mb-[var(--space-8)]">
        <button
          onClick={() => setBillingCycle("monthly")}
          className={`filter-chip min-h-[var(--touch-target-min)] ${
            billingCycle === "monthly" ? "filter-chip-active" : ""
          }`}
        >
          Monthly
        </button>
        <button
          onClick={() => setBillingCycle("annual")}
          className={`filter-chip min-h-[var(--touch-target-min)] ${
            billingCycle === "annual" ? "filter-chip-active" : ""
          }`}
        >
          Annual
          <span className="text-[10px] font-semibold text-status-live ml-[var(--space-1)]">
            Save 20%
          </span>
        </button>
      </div>

      {/* Pricing cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-[var(--space-4)] mb-[var(--space-12)]">
        {plans.map((plan) => {
          const isCurrent = plan.tier === CURRENT_PLAN;
          const isPopular = plan.tier === "pro";
          const displayPrice =
            billingCycle === "annual" && plan.price !== "Custom"
              ? `$${Math.round(parseInt(plan.price.replace("$", ""), 10) * 0.8)}`
              : plan.price;

          return (
            <div
              key={plan.tier}
              className={`card card-lift glass-light relative overflow-hidden flex flex-col ${
                isPopular ? "border-accent/40" : ""
              }`}
            >
              {/* Popular badge */}
              {isPopular && (
                <div className="absolute top-0 right-0 px-[var(--space-3)] py-[var(--space-1)] rounded-bl-lg bg-accent text-text-inverse text-[10px] font-bold uppercase tracking-wide">
                  Most Popular
                </div>
              )}

              {/* Header */}
              <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-4)]">
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center ${plan.glowClass} ${plan.accentClass}`}
                >
                  {plan.icon}
                </div>
                <div>
                  <h3 className="text-[var(--text-md)] font-bold text-text-primary">
                    {plan.name}
                  </h3>
                  <p className="text-[var(--text-xs)] text-text-muted">
                    {plan.description}
                  </p>
                </div>
              </div>

              {/* Price */}
              <div className="mb-[var(--space-6)]">
                <span className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
                  {displayPrice}
                </span>
                {plan.period && (
                  <span className="text-[var(--text-sm)] text-text-muted">
                    {billingCycle === "annual" ? "/year" : plan.period}
                  </span>
                )}
              </div>

              {/* Features */}
              <ul className="flex-1 space-y-[var(--space-3)] mb-[var(--space-6)]">
                {plan.features.map((feature) => (
                  <li
                    key={feature}
                    className="flex items-start gap-[var(--space-2)] text-[var(--text-sm)] text-text-secondary"
                  >
                    <Check
                      size={14}
                      className={`flex-shrink-0 mt-0.5 ${plan.accentClass}`}
                    />
                    {feature}
                  </li>
                ))}
              </ul>

              {/* CTA */}
              {isCurrent ? (
                <div className="w-full text-center py-[var(--space-3)] rounded-lg border border-border-default bg-surface-overlay text-[var(--text-sm)] font-medium text-text-muted min-h-[var(--touch-target-min)] flex items-center justify-center">
                  Current Plan
                </div>
              ) : (
                <button
                  className={`btn w-full min-h-[var(--touch-target-min)] text-[var(--text-sm)] ${
                    isPopular ? "btn-primary" : "btn-secondary"
                  }`}
                >
                  {plan.tier === "enterprise" ? (
                    <>
                      Contact Sales
                      <ArrowUpRight size={14} />
                    </>
                  ) : (
                    <>
                      Upgrade to {plan.name}
                      <Zap size={14} />
                    </>
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Feature comparison table */}
      <section>
        <h2 className="text-[var(--text-md)] font-bold text-text-primary mb-[var(--space-4)]">
          Feature Comparison
        </h2>
        <div className="card overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="text-left">Feature</th>
                  <th className="text-center">Free</th>
                  <th className="text-center">Pro</th>
                  <th className="text-center">Enterprise</th>
                </tr>
              </thead>
              <tbody>
                {comparisonFeatures.map((feature) => (
                  <tr key={feature.name}>
                    <td className="text-[var(--text-sm)] text-text-primary font-medium">
                      {feature.name}
                    </td>
                    <td className="text-center">
                      <FeatureCell value={feature.free} />
                    </td>
                    <td className="text-center">
                      <FeatureCell value={feature.pro} />
                    </td>
                    <td className="text-center">
                      <FeatureCell value={feature.enterprise} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function FeatureCell({ value }: { value: boolean | string }) {
  if (value === true) {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-status-live/10">
        <Check size={12} className="text-status-live" />
      </span>
    );
  }
  if (value === false) {
    return (
      <span className="text-[var(--text-sm)] text-text-muted">&mdash;</span>
    );
  }
  return (
    <span className="text-[var(--text-sm)] text-text-secondary font-mono">
      {value}
    </span>
  );
}

export { PricingPage as default };
