import { useMemo } from "react";
import {
  Check,
  CreditCard,
  Sparkles,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { useApiQuery } from "../../lib/api";
import { useToast } from "../../components/common/ToastProvider";

/* ── Types ──────────────────────────────────────────────────────── */

type Plan = {
  id: string;
  name: string;
  description?: string;
  price_monthly?: number;
  price_yearly?: number;
  features?: string[];
  limits?: Record<string, number | string>;
  highlighted?: boolean;
};

type Subscription = {
  plan_id: string;
  status?: string;
  current_period_end?: string;
};

/* ── Pricing Page ───────────────────────────────────────────────── */

export function PricingPage() {
  const { showToast } = useToast();

  const { data: plansData, loading: plansLoading, error: plansError, refetch: refetchPlans } =
    useApiQuery<Plan[]>("/api/v1/billing/plans");

  const { data: subscription, loading: subLoading } =
    useApiQuery<Subscription>("/api/v1/billing/subscription");

  const plans = useMemo(() => plansData ?? [], [plansData]);
  const currentPlanId = subscription?.plan_id;
  const loading = plansLoading || subLoading;

  const handleSelectPlan = (planId: string) => {
    if (planId === currentPlanId) {
      showToast("You are already on this plan", "info");
      return;
    }
    // In a real implementation this would open a checkout flow
    showToast(`Contact sales to switch to this plan`, "info");
  };

  return (
    <div>
      <PageHeader
        title="Pricing"
        subtitle="Choose the plan that fits your needs"
        onRefresh={() => void refetchPlans()}
      />

      <QueryState
        loading={loading}
        error={plansError}
        isEmpty={plans.length === 0}
        emptyMessage="No pricing plans available"
        onRetry={() => void refetchPlans()}
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-5xl mx-auto">
          {plans.map((plan) => {
            const isCurrent = plan.id === currentPlanId;
            const isHighlighted = plan.highlighted;

            return (
              <div
                key={plan.id}
                className={`card relative ${
                  isHighlighted
                    ? "border-accent ring-1 ring-accent/20"
                    : ""
                }`}
              >
                {isHighlighted && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="px-3 py-1 text-[10px] font-semibold uppercase bg-accent text-white rounded-full flex items-center gap-1">
                      <Sparkles size={10} />
                      Popular
                    </span>
                  </div>
                )}

                <div className="text-center mb-4 pt-2">
                  <h3 className="text-lg font-bold text-text-primary">
                    {plan.name}
                  </h3>
                  {plan.description && (
                    <p className="text-xs text-text-muted mt-1">
                      {plan.description}
                    </p>
                  )}
                </div>

                <div className="text-center mb-6">
                  {plan.price_monthly != null ? (
                    <div>
                      <span className="text-3xl font-bold text-text-primary font-mono">
                        ${plan.price_monthly}
                      </span>
                      <span className="text-xs text-text-muted">/month</span>
                    </div>
                  ) : (
                    <span className="text-xl font-bold text-text-primary">
                      Custom
                    </span>
                  )}
                  {plan.price_yearly != null && (
                    <p className="text-[10px] text-text-muted mt-1">
                      ${plan.price_yearly}/year (save{" "}
                      {plan.price_monthly
                        ? Math.round(
                            (1 - plan.price_yearly / (plan.price_monthly * 12)) * 100,
                          )
                        : 0}
                      %)
                    </p>
                  )}
                </div>

                {/* Features list */}
                {plan.features && plan.features.length > 0 && (
                  <ul className="space-y-2 mb-6">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2">
                        <Check
                          size={14}
                          className="text-status-live flex-shrink-0 mt-0.5"
                        />
                        <span className="text-xs text-text-secondary">
                          {feature}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {/* Limits */}
                {plan.limits && Object.keys(plan.limits).length > 0 && (
                  <div className="border-t border-border-default pt-3 mb-4">
                    <p className="text-[10px] text-text-muted uppercase tracking-wide mb-2">
                      Limits
                    </p>
                    <dl className="space-y-1">
                      {Object.entries(plan.limits).map(([key, value]) => (
                        <div key={key} className="flex items-center justify-between">
                          <dt className="text-[10px] text-text-muted capitalize">
                            {key.replace(/_/g, " ")}
                          </dt>
                          <dd className="text-[10px] font-mono text-text-primary">
                            {typeof value === "number"
                              ? value.toLocaleString()
                              : value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}

                <button
                  className={`w-full text-xs min-h-[var(--touch-target-min)] ${
                    isCurrent
                      ? "btn btn-secondary"
                      : isHighlighted
                        ? "btn btn-primary"
                        : "btn btn-secondary"
                  }`}
                  onClick={() => handleSelectPlan(plan.id)}
                >
                  <CreditCard size={14} />
                  {isCurrent ? "Current Plan" : "Select Plan"}
                </button>
              </div>
            );
          })}
        </div>
      </QueryState>
    </div>
  );
}

export { PricingPage as default };
