import { useMemo } from "react";
import { CreditCard, TrendingUp, Zap, FileText, ExternalLink } from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { Tabs } from "../../components/common/Tabs";
import { useToast } from "../../components/common/ToastProvider";
import { useApiQuery } from "../../lib/api";

type UsageItem = { category: string; quantity: number; unit: string; cost_usd: number };
type Invoice = { invoice_id: string; date: string; amount_usd: number; status: string; pdf_url?: string };
type Plan = { name: string; tier: string; limits: Record<string, number | string>; price_usd?: number };

export const BillingPage = () => {
  const { showToast } = useToast();
  const usageQuery = useApiQuery<{ usage: UsageItem[]; total_usd?: number; period?: string }>("/api/v1/billing/usage");
  const invoicesQuery = useApiQuery<{ invoices: Invoice[] }>("/api/v1/billing/invoices");
  const planQuery = useApiQuery<{ plan: Plan }>("/api/v1/billing/plan");

  const usage = useMemo(() => usageQuery.data?.usage ?? [], [usageQuery.data]);
  const invoices = useMemo(() => invoicesQuery.data?.invoices ?? [], [invoicesQuery.data]);
  const plan = planQuery.data?.plan;
  const totalUsd = usageQuery.data?.total_usd ?? usage.reduce((sum, u) => sum + u.cost_usd, 0);

  /* ── Overview tab ─────────────────────────────────────────── */
  const overviewTab = (
    <div>
      {/* Plan card */}
      <div className="card mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">Current Plan</h3>
          <button className="btn btn-secondary text-xs" onClick={() => showToast("Upgrade flow coming soon", "info")}>
            <Zap size={12} /> Upgrade
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

  return (
    <div>
      <PageHeader title="Billing & Usage" subtitle="Plan management, usage breakdown, and invoices" onRefresh={() => { void usageQuery.refetch(); void invoicesQuery.refetch(); void planQuery.refetch(); }} />
      {overviewTab}
      <Tabs tabs={[
        { id: "usage", label: "Usage", count: usage.length, content: usageTab },
        { id: "invoices", label: "Invoices", count: invoices.length, content: invoicesTab },
      ]} />
    </div>
  );
};
