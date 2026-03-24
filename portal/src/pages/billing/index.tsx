import { useMemo, useState } from "react";
import { CreditCard, TrendingUp, Zap, FileText, ExternalLink, BarChart3, Settings } from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { Tabs } from "../../components/common/Tabs";
import { useToast } from "../../components/common/ToastProvider";
import { apiRequest, useApiQuery } from "../../lib/api";

type UsageItem = { category: string; quantity: number; unit: string; cost_usd: number };
type Invoice = { invoice_id: string; date: string; amount_usd: number; status: string; pdf_url?: string };
type Plan = { name: string; tier: string; limits: Record<string, number | string>; price_usd?: number };
type DailyUsage = { date: string; cost_usd: number; requests: number };
type StripeStatus = { subscription_id?: string; status?: string; current_period_end?: string; plan_name?: string; cancel_at_period_end?: boolean };

export const BillingPage = () => {
  const { showToast } = useToast();
  const usageQuery = useApiQuery<{ usage: UsageItem[]; total_usd?: number; period?: string }>("/api/v1/billing/usage");
  const invoicesQuery = useApiQuery<{ invoices: Invoice[] }>("/api/v1/billing/invoices");
  const planQuery = useApiQuery<{ plan: Plan }>("/api/v1/billing/plan");
  const dailyUsageQuery = useApiQuery<{ daily: DailyUsage[] }>("/api/v1/billing/usage/daily");
  const stripeStatusQuery = useApiQuery<StripeStatus>("/api/v1/stripe/status");
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);

  const dailyUsage = useMemo(() => dailyUsageQuery.data?.daily ?? [], [dailyUsageQuery.data]);
  const stripeStatus = stripeStatusQuery.data;

  const handleUpgradePlan = async () => {
    setCheckoutLoading(true);
    try {
      const result = await apiRequest<{ url: string }>("/api/v1/stripe/checkout", "POST");
      if (result.url) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      } else {
        showToast("No checkout URL returned", "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to start checkout", "error");
    } finally {
      setCheckoutLoading(false);
    }
  };

  const handleManageSubscription = async () => {
    setPortalLoading(true);
    try {
      const result = await apiRequest<{ url: string }>("/api/v1/stripe/portal", "POST");
      if (result.url) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      } else {
        showToast("No portal URL returned", "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to open billing portal", "error");
    } finally {
      setPortalLoading(false);
    }
  };

  const usage = useMemo(() => usageQuery.data?.usage ?? [], [usageQuery.data]);
  const invoices = useMemo(() => invoicesQuery.data?.invoices ?? [], [invoicesQuery.data]);
  const plan = planQuery.data?.plan;
  const totalUsd = usageQuery.data?.total_usd ?? usage.reduce((sum, u) => sum + u.cost_usd, 0);

  /* ── Overview tab ─────────────────────────────────────────── */
  const overviewTab = (
    <div>
      {/* Subscription status */}
      {stripeStatus?.status && (
        <div className="card mb-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] text-text-muted uppercase mb-1">Subscription</p>
              <div className="flex items-center gap-2">
                <StatusBadge status={stripeStatus.status} />
                {stripeStatus.plan_name && <span className="text-xs text-text-secondary">{stripeStatus.plan_name}</span>}
              </div>
              {stripeStatus.current_period_end && (
                <p className="text-[10px] text-text-muted mt-1">
                  {stripeStatus.cancel_at_period_end ? "Cancels" : "Renews"} {new Date(stripeStatus.current_period_end).toLocaleDateString()}
                </p>
              )}
            </div>
            <button
              className="btn btn-secondary text-xs"
              disabled={portalLoading}
              onClick={() => void handleManageSubscription()}
            >
              <Settings size={12} /> {portalLoading ? "Opening..." : "Manage Subscription"}
            </button>
          </div>
        </div>
      )}

      {/* Plan card */}
      <div className="card mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">Current Plan</h3>
          <button
            className="btn btn-primary text-xs"
            disabled={checkoutLoading}
            onClick={() => void handleUpgradePlan()}
          >
            <Zap size={12} /> {checkoutLoading ? "Redirecting..." : "Upgrade Plan"}
          </button>
        </div>
        <QueryState loading={planQuery.loading} error={planQuery.error} isEmpty={!plan} emptyMessage="No plan data">
          {plan && (
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-[10px] text-text-muted uppercase mb-1">Plan</p>
                <p className="text-lg font-bold text-text-primary">{plan.name}</p>
                <StatusBadge status={plan.tier} />
              </div>
              <div>
                <p className="text-[10px] text-text-muted uppercase mb-1">Price</p>
                <p className="text-lg font-bold text-text-primary">${plan.price_usd ?? 0}<span className="text-xs text-text-muted">/mo</span></p>
              </div>
              <div>
                <p className="text-[10px] text-text-muted uppercase mb-1">Limits</p>
                <div className="space-y-1">
                  {Object.entries(plan.limits ?? {}).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between">
                      <span className="text-[10px] text-text-muted">{k}</span>
                      <span className="text-xs font-mono text-text-secondary">{String(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </QueryState>
      </div>

      {/* Current period stats */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-accent/10"><CreditCard size={14} className="text-accent" /></div>
          <div><p className="text-lg font-bold text-text-primary font-mono">${totalUsd.toFixed(2)}</p><p className="text-[10px] text-text-muted uppercase">Current Period</p></div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-blue/10"><TrendingUp size={14} className="text-chart-blue" /></div>
          <div><p className="text-lg font-bold text-text-primary font-mono">{usage.length}</p><p className="text-[10px] text-text-muted uppercase">Categories</p></div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-green/10"><FileText size={14} className="text-chart-green" /></div>
          <div><p className="text-lg font-bold text-text-primary font-mono">{invoices.length}</p><p className="text-[10px] text-text-muted uppercase">Invoices</p></div>
        </div>
      </div>
    </div>
  );

  /* ── Usage tab ────────────────────────────────────────────── */
  const usageTab = (
    <div>
      <QueryState loading={usageQuery.loading} error={usageQuery.error} isEmpty={usage.length === 0} emptyMessage="" onRetry={() => void usageQuery.refetch()}>
        {usage.length === 0 ? (
          <EmptyState icon={<TrendingUp size={40} />} title="No usage data" description="Usage data will appear once agents start running" />
        ) : (
          <div className="card p-0"><div className="overflow-x-auto">
            <table><thead><tr><th>Category</th><th>Quantity</th><th>Unit</th><th>Cost</th><th>% of Total</th></tr></thead>
              <tbody>{usage.map((u) => {
                const pct = totalUsd > 0 ? (u.cost_usd / totalUsd) * 100 : 0;
                return (
                  <tr key={u.category}>
                    <td><span className="text-text-primary text-sm">{u.category}</span></td>
                    <td><span className="font-mono text-xs text-text-secondary">{u.quantity.toLocaleString()}</span></td>
                    <td><span className="text-xs text-text-muted">{u.unit}</span></td>
                    <td><span className="font-mono text-xs text-text-primary">${u.cost_usd.toFixed(2)}</span></td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-surface-overlay rounded-full overflow-hidden max-w-[80px]">
                          <div className="h-full bg-accent rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[10px] text-text-muted font-mono">{pct.toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}</tbody>
              <tfoot><tr className="border-t border-border-default">
                <td colSpan={3} className="text-right"><span className="text-xs font-semibold text-text-primary">Total</span></td>
                <td><span className="font-mono text-sm font-bold text-accent">${totalUsd.toFixed(2)}</span></td>
                <td></td>
              </tr></tfoot>
            </table>
          </div></div>
        )}
      </QueryState>
    </div>
  );

  /* ── Invoices tab ─────────────────────────────────────────── */
  const invoicesTab = (
    <div>
      <QueryState loading={invoicesQuery.loading} error={invoicesQuery.error} isEmpty={invoices.length === 0} emptyMessage="" onRetry={() => void invoicesQuery.refetch()}>
        {invoices.length === 0 ? (
          <EmptyState icon={<FileText size={40} />} title="No invoices" description="Invoices will appear after the first billing cycle" />
        ) : (
          <div className="card p-0"><div className="overflow-x-auto">
            <table><thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>Invoice</th></tr></thead>
              <tbody>{invoices.map((inv) => (
                <tr key={inv.invoice_id}>
                  <td><span className="text-text-primary text-sm">{new Date(inv.date).toLocaleDateString()}</span></td>
                  <td><span className="font-mono text-sm text-text-primary">${inv.amount_usd.toFixed(2)}</span></td>
                  <td><StatusBadge status={inv.status} /></td>
                  <td>{inv.pdf_url ? <a href={inv.pdf_url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline flex items-center gap-1"><ExternalLink size={10} /> Download</a> : <span className="text-xs text-text-muted">--</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div></div>
        )}
      </QueryState>
    </div>
  );

  /* ── Daily usage tab ──────────────────────────────────────── */
  const dailyMax = Math.max(...dailyUsage.map((d) => d.cost_usd), 1);
  const dailyUsageTab = (
    <div>
      <QueryState loading={dailyUsageQuery.loading} error={dailyUsageQuery.error} isEmpty={dailyUsage.length === 0} emptyMessage="" onRetry={() => void dailyUsageQuery.refetch()}>
        {dailyUsage.length === 0 ? (
          <EmptyState icon={<BarChart3 size={40} />} title="No daily usage data" description="Daily usage data will appear as agents start running" />
        ) : (
          <div className="card">
            <h3 className="text-sm font-semibold text-text-primary mb-4">Daily Cost</h3>
            <div className="flex items-end gap-1" style={{ height: 160 }}>
              {dailyUsage.map((d) => {
                const pct = (d.cost_usd / dailyMax) * 100;
                return (
                  <div key={d.date} className="flex-1 flex flex-col items-center gap-1 group relative">
                    <div className="absolute -top-6 left-1/2 -translate-x-1/2 hidden group-hover:block bg-surface-overlay text-text-primary text-[10px] px-1.5 py-0.5 rounded border border-border-default whitespace-nowrap z-10">
                      {d.date}: ${d.cost_usd.toFixed(2)} ({d.requests.toLocaleString()} reqs)
                    </div>
                    <div className="w-full bg-accent/80 rounded-t-sm transition-all" style={{ height: `${Math.max(pct, 2)}%` }} />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between mt-2">
              <span className="text-[10px] text-text-muted">{dailyUsage[0]?.date ?? ""}</span>
              <span className="text-[10px] text-text-muted">{dailyUsage[dailyUsage.length - 1]?.date ?? ""}</span>
            </div>
            {/* Summary table */}
            <div className="mt-4 card p-0"><div className="overflow-x-auto">
              <table><thead><tr><th>Date</th><th>Requests</th><th>Cost</th></tr></thead>
                <tbody>{dailyUsage.slice().reverse().map((d) => (
                  <tr key={d.date}>
                    <td><span className="text-text-primary text-sm">{d.date}</span></td>
                    <td><span className="font-mono text-xs text-text-secondary">{d.requests.toLocaleString()}</span></td>
                    <td><span className="font-mono text-xs text-text-primary">${d.cost_usd.toFixed(2)}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div></div>
          </div>
        )}
      </QueryState>
    </div>
  );

  return (
    <div>
      <PageHeader title="Billing & Usage" subtitle="Plan management, usage breakdown, and invoices" onRefresh={() => { void usageQuery.refetch(); void invoicesQuery.refetch(); void planQuery.refetch(); void dailyUsageQuery.refetch(); void stripeStatusQuery.refetch(); }} />
      {overviewTab}
      <Tabs tabs={[
        { id: "usage", label: "Usage", count: usage.length, content: usageTab },
        { id: "daily", label: "Daily Usage", count: dailyUsage.length, content: dailyUsageTab },
        { id: "invoices", label: "Invoices", count: invoices.length, content: invoicesTab },
      ]} />
    </div>
  );
};
