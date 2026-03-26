import { useMemo, useState } from "react";
import { Plus, Shield, DollarSign, Trash2, Pencil, Search, Eye, AlertTriangle, CheckCircle } from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { FormField } from "../../components/common/FormField";
import { SlidePanel } from "../../components/common/SlidePanel";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { ActionMenu, type ActionMenuItem } from "../../components/common/ActionMenu";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { Tabs } from "../../components/common/Tabs";
import { TagInput } from "../../components/common/TagInput";
import { useToast } from "../../components/common/ToastProvider";
import { apiRequest, useApiQuery } from "../../lib/api";
import { extractList } from "../../lib/normalize";

type Policy = { policy_id: string; name: string; type?: string; description?: string; rules?: string[]; is_active?: boolean };
type Budget = { budget_id: string; agent_name?: string; limit_usd?: number; spent_usd?: number; period?: string; alert_threshold?: number };
type ApprovalRule = { rule_id: string; name?: string; trigger?: string; approvers?: string[]; status?: string };

export const GovernancePage = () => {
  const { showToast } = useToast();
  const policiesQuery = useApiQuery<{ policies: Policy[] } | Policy[]>("/api/v1/governance/policies");
  const budgetsQuery = useApiQuery<{ budgets: Budget[] } | Budget[]>("/api/v1/governance/budgets");
  const approvalsQuery = useApiQuery<{ rules: ApprovalRule[] } | ApprovalRule[]>("/api/v1/governance/approvals");
  const policies = useMemo(() => extractList<Policy>(policiesQuery.data, "policies"), [policiesQuery.data]);
  const budgets = useMemo(() => extractList<Budget>(budgetsQuery.data, "budgets"), [budgetsQuery.data]);
  const approvalRules = useMemo(() => extractList<ApprovalRule>(approvalsQuery.data, "rules"), [approvalsQuery.data]);

  const [search, setSearch] = useState("");

  /* ── Policy panel ─────────────────────────────────────────── */
  const [policyPanelOpen, setPolicyPanelOpen] = useState(false);
  const [policyMode, setPolicyMode] = useState<"create" | "edit">("create");
  const [policyForm, setPolicyForm] = useState({ name: "", type: "safety", description: "", rules: [] as string[] });
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);
  const [policyErrors, setPolicyErrors] = useState<Record<string, string>>({});

  /* ── Budget panel ─────────────────────────────────────────── */
  const [budgetPanelOpen, setBudgetPanelOpen] = useState(false);
  const [budgetForm, setBudgetForm] = useState({ agent_name: "", limit_usd: 100, period: "monthly", alert_threshold: 80 });

  /* ── Approval panel ───────────────────────────────────────── */
  const [approvalPanelOpen, setApprovalPanelOpen] = useState(false);
  const [approvalForm, setApprovalForm] = useState({ name: "", trigger: "", approvers: [] as string[] });

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ title: string; desc: string; action: () => Promise<void> } | null>(null);

  /* ── Policy CRUD ──────────────────────────────────────────── */
  const handleSavePolicy = async () => {
    const errors: Record<string, string> = {};
    if (!policyForm.name.trim()) errors.name = "Required";
    setPolicyErrors(errors);
    if (Object.keys(errors).length > 0) return;
    try {
      if (policyMode === "create") {
        await apiRequest("/api/v1/governance/policies", "POST", policyForm);
        showToast("Policy created", "success");
      } else {
        await apiRequest(`/api/v1/governance/policies/${editingPolicyId}`, "PUT", policyForm);
        showToast("Policy updated", "success");
      }
      setPolicyPanelOpen(false);
      void policiesQuery.refetch();
    } catch { showToast("Failed to save policy", "error"); }
  };

  const handleDeletePolicy = (p: Policy) => {
    setConfirmAction({ title: "Delete Policy", desc: `Delete "${p.name}"?`, action: async () => {
      await apiRequest(`/api/v1/governance/policies/${p.policy_id}`, "DELETE");
      showToast("Policy deleted", "success");
      void policiesQuery.refetch();
    }});
    setConfirmOpen(true);
  };

  /* ── Budget CRUD ──────────────────────────────────────────── */
  const handleSaveBudget = async () => {
    if (!budgetForm.agent_name.trim()) return;
    try {
      await apiRequest("/api/v1/governance/budgets", "POST", budgetForm);
      showToast("Budget created", "success");
      setBudgetPanelOpen(false);
      void budgetsQuery.refetch();
    } catch { showToast("Failed to save budget", "error"); }
  };

  const handleDeleteBudget = (b: Budget) => {
    setConfirmAction({ title: "Delete Budget", desc: `Remove budget for "${b.agent_name}"?`, action: async () => {
      await apiRequest(`/api/v1/governance/budgets/${b.budget_id}`, "DELETE");
      showToast("Budget deleted", "success");
      void budgetsQuery.refetch();
    }});
    setConfirmOpen(true);
  };

  /* ── Approval CRUD ────────────────────────────────────────── */
  const handleSaveApproval = async () => {
    if (!approvalForm.name.trim()) return;
    try {
      await apiRequest("/api/v1/governance/approvals", "POST", approvalForm);
      showToast("Approval rule created", "success");
      setApprovalPanelOpen(false);
      void approvalsQuery.refetch();
    } catch { showToast("Failed to save rule", "error"); }
  };

  /* ── Policy actions ───────────────────────────────────────── */
  const getPolicyActions = (p: Policy): ActionMenuItem[] => [
    { label: "Edit", icon: <Pencil size={12} />, onClick: () => { setPolicyForm({ name: p.name, type: p.type ?? "safety", description: p.description ?? "", rules: p.rules ?? [] }); setEditingPolicyId(p.policy_id); setPolicyMode("edit"); setPolicyErrors({}); setPolicyPanelOpen(true); } },
    { label: "View", icon: <Eye size={12} />, onClick: () => { setDetailItem(p); setDetailOpen(true); } },
    { label: "Delete", icon: <Trash2 size={12} />, onClick: () => handleDeletePolicy(p), danger: true },
  ];

  const getBudgetActions = (b: Budget): ActionMenuItem[] => [
    { label: "View", icon: <Eye size={12} />, onClick: () => { setDetailItem(b); setDetailOpen(true); } },
    { label: "Delete", icon: <Trash2 size={12} />, onClick: () => handleDeleteBudget(b), danger: true },
  ];

  const filteredPolicies = search ? policies.filter((p) => p.name.toLowerCase().includes(search.toLowerCase())) : policies;

  /* ── Policies tab ─────────────────────────────────────────── */
  const policiesTab = (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input type="text" placeholder="Search policies..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8 text-xs" />
        </div>
        <button className="btn btn-primary text-xs" onClick={() => { setPolicyForm({ name: "", type: "safety", description: "", rules: [] }); setPolicyMode("create"); setPolicyErrors({}); setPolicyPanelOpen(true); }}>
          <Plus size={12} /> New Policy
        </button>
      </div>
      {filteredPolicies.length === 0 ? (
        <EmptyState icon={<Shield size={40} />} title="No policies" description="Create governance policies to control agent behavior" />
      ) : (
        <div className="card p-0"><div className="overflow-x-auto">
          <table><thead><tr><th>Name</th><th>Type</th><th>Rules</th><th>Status</th><th style={{ width: "48px" }}></th></tr></thead>
            <tbody>{filteredPolicies.map((p) => (
              <tr key={p.policy_id}>
                <td><span className="text-text-primary text-sm font-medium">{p.name}</span></td>
                <td><span className="px-1.5 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded border border-border-default">{p.type ?? "general"}</span></td>
                <td><span className="text-xs text-text-muted font-mono">{(p.rules ?? []).length}</span></td>
                <td><StatusBadge status={p.is_active !== false ? "active" : "disabled"} /></td>
                <td><ActionMenu items={getPolicyActions(p)} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      )}
    </div>
  );

  /* ── Budgets tab ──────────────────────────────────────────── */
  const budgetsTab = (
    <div>
      <div className="flex items-center justify-end mb-4">
        <button className="btn btn-primary text-xs" onClick={() => { setBudgetForm({ agent_name: "", limit_usd: 100, period: "monthly", alert_threshold: 80 }); setBudgetPanelOpen(true); }}>
          <Plus size={12} /> New Budget
        </button>
      </div>
      {budgets.length === 0 ? (
        <EmptyState icon={<DollarSign size={40} />} title="No budgets" description="Set spending limits for agents" />
      ) : (
        <div className="grid gap-3">
          {budgets.map((b) => {
            const pct = b.limit_usd ? Math.round(((b.spent_usd ?? 0) / b.limit_usd) * 100) : 0;
            const isWarning = pct >= (b.alert_threshold ?? 80);
            return (
              <div key={b.budget_id} className="card py-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <DollarSign size={14} className={isWarning ? "text-status-warning" : "text-chart-green"} />
                    <span className="text-sm font-medium text-text-primary">{b.agent_name ?? "All agents"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-muted">{b.period ?? "monthly"}</span>
                    <ActionMenu items={getBudgetActions(b)} />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-2 bg-surface-overlay rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${isWarning ? "bg-status-warning" : "bg-chart-green"}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                  </div>
                  <span className="text-xs font-mono text-text-muted">${(b.spent_usd ?? 0).toFixed(2)} / ${(b.limit_usd ?? 0).toFixed(2)}</span>
                </div>
                {isWarning && (
                  <div className="flex items-center gap-1 mt-2">
                    <AlertTriangle size={10} className="text-status-warning" />
                    <span className="text-[10px] text-status-warning">Approaching budget limit ({pct}%)</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  /* ── Approvals tab ────────────────────────────────────────── */
  const approvalsTab = (
    <div>
      <div className="flex items-center justify-end mb-4">
        <button className="btn btn-primary text-xs" onClick={() => { setApprovalForm({ name: "", trigger: "", approvers: [] }); setApprovalPanelOpen(true); }}>
          <Plus size={12} /> New Rule
        </button>
      </div>
      {approvalRules.length === 0 ? (
        <EmptyState icon={<CheckCircle size={40} />} title="No approval rules" description="Create rules that require human approval before agent actions" />
      ) : (
        <div className="card p-0"><div className="overflow-x-auto">
          <table><thead><tr><th>Name</th><th>Trigger</th><th>Approvers</th><th>Status</th></tr></thead>
            <tbody>{approvalRules.map((r) => (
              <tr key={r.rule_id}>
                <td><span className="text-text-primary text-sm">{r.name ?? r.rule_id.slice(0, 12)}</span></td>
                <td><span className="font-mono text-xs text-text-muted">{r.trigger ?? "--"}</span></td>
                <td><div className="flex flex-wrap gap-1">{(r.approvers ?? []).map((a) => <span key={a} className="px-1.5 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded border border-border-default">{a}</span>)}</div></td>
                <td><StatusBadge status={r.status ?? "active"} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader title="Governance" subtitle="Policies, budgets, and approval rules for agent oversight" onRefresh={() => { void policiesQuery.refetch(); void budgetsQuery.refetch(); void approvalsQuery.refetch(); }} />

      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-purple/10"><Shield size={14} className="text-chart-purple" /></div>
          <div><p className="text-lg font-bold text-text-primary font-mono">{policies.length}</p><p className="text-[10px] text-text-muted uppercase">Policies</p></div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-green/10"><DollarSign size={14} className="text-chart-green" /></div>
          <div><p className="text-lg font-bold text-text-primary font-mono">{budgets.length}</p><p className="text-[10px] text-text-muted uppercase">Budgets</p></div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-accent/10"><CheckCircle size={14} className="text-accent" /></div>
          <div><p className="text-lg font-bold text-text-primary font-mono">{approvalRules.length}</p><p className="text-[10px] text-text-muted uppercase">Approval Rules</p></div>
        </div>
      </div>

      <Tabs tabs={[
        { id: "policies", label: "Policies", count: policies.length, content: policiesTab },
        { id: "budgets", label: "Budgets", count: budgets.length, content: budgetsTab },
        { id: "approvals", label: "Approvals", count: approvalRules.length, content: approvalsTab },
      ]} />

      {/* Policy panel */}
      <SlidePanel isOpen={policyPanelOpen} onClose={() => setPolicyPanelOpen(false)} title={policyMode === "create" ? "Create Policy" : "Edit Policy"} subtitle="Define governance rules"
        footer={<><button className="btn btn-secondary text-xs" onClick={() => setPolicyPanelOpen(false)}>Cancel</button><button className="btn btn-primary text-xs" onClick={() => void handleSavePolicy()}>{policyMode === "create" ? "Create" : "Update"}</button></>}>
        <FormField label="Name" required error={policyErrors.name}><input type="text" value={policyForm.name} onChange={(e) => setPolicyForm({ ...policyForm, name: e.target.value })} placeholder="content-safety" className="text-sm" /></FormField>
        <FormField label="Type">
          <select value={policyForm.type} onChange={(e) => setPolicyForm({ ...policyForm, type: e.target.value })} className="text-sm">
            <option value="safety">Safety</option>
            <option value="compliance">Compliance</option>
            <option value="cost">Cost</option>
            <option value="access">Access Control</option>
          </select>
        </FormField>
        <FormField label="Description"><textarea value={policyForm.description} onChange={(e) => setPolicyForm({ ...policyForm, description: e.target.value })} placeholder="Policy description..." rows={3} className="text-sm" /></FormField>
        <FormField label="Rules" hint="Press Enter to add each rule">
          <TagInput tags={policyForm.rules} onChange={(rules) => setPolicyForm({ ...policyForm, rules })} placeholder="no-pii-in-responses" />
        </FormField>
      </SlidePanel>

      {/* Budget panel */}
      <SlidePanel isOpen={budgetPanelOpen} onClose={() => setBudgetPanelOpen(false)} title="Create Budget" subtitle="Set spending limits"
        footer={<><button className="btn btn-secondary text-xs" onClick={() => setBudgetPanelOpen(false)}>Cancel</button><button className="btn btn-primary text-xs" onClick={() => void handleSaveBudget()}>Create</button></>}>
        <FormField label="Agent Name" required><input type="text" value={budgetForm.agent_name} onChange={(e) => setBudgetForm({ ...budgetForm, agent_name: e.target.value })} placeholder="my-agent" className="text-sm" /></FormField>
        <FormField label="Limit (USD)"><input type="number" value={budgetForm.limit_usd} onChange={(e) => setBudgetForm({ ...budgetForm, limit_usd: Number(e.target.value) })} min={0} className="text-sm" /></FormField>
        <FormField label="Period">
          <select value={budgetForm.period} onChange={(e) => setBudgetForm({ ...budgetForm, period: e.target.value })} className="text-sm">
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </FormField>
        <FormField label="Alert Threshold (%)" hint="Alert when spending exceeds this percentage">
          <input type="number" value={budgetForm.alert_threshold} onChange={(e) => setBudgetForm({ ...budgetForm, alert_threshold: Number(e.target.value) })} min={0} max={100} className="text-sm" />
        </FormField>
      </SlidePanel>

      {/* Approval panel */}
      <SlidePanel isOpen={approvalPanelOpen} onClose={() => setApprovalPanelOpen(false)} title="Create Approval Rule" subtitle="Require human approval for specific actions"
        footer={<><button className="btn btn-secondary text-xs" onClick={() => setApprovalPanelOpen(false)}>Cancel</button><button className="btn btn-primary text-xs" onClick={() => void handleSaveApproval()}>Create</button></>}>
        <FormField label="Rule Name" required><input type="text" value={approvalForm.name} onChange={(e) => setApprovalForm({ ...approvalForm, name: e.target.value })} placeholder="high-cost-actions" className="text-sm" /></FormField>
        <FormField label="Trigger" hint="e.g. cost > $50, tool = delete_user"><input type="text" value={approvalForm.trigger} onChange={(e) => setApprovalForm({ ...approvalForm, trigger: e.target.value })} placeholder="cost > 50" className="text-sm font-mono" /></FormField>
        <FormField label="Approvers" hint="Press Enter to add email">
          <TagInput tags={approvalForm.approvers} onChange={(approvers) => setApprovalForm({ ...approvalForm, approvers })} placeholder="admin@company.com" />
        </FormField>
      </SlidePanel>

      <SlidePanel isOpen={detailOpen} onClose={() => { setDetailOpen(false); setDetailItem(null); }} title="Details">
        <pre className="text-xs font-mono bg-surface-base border border-border-default rounded-md p-4 overflow-x-auto max-h-96">{JSON.stringify(detailItem, null, 2)}</pre>
      </SlidePanel>

      {confirmOpen && confirmAction && (
        <ConfirmDialog title={confirmAction.title} description={confirmAction.desc} confirmLabel="Delete" tone="danger"
          onConfirm={async () => { try { await confirmAction.action(); } catch { showToast("Action failed", "error"); } setConfirmOpen(false); setConfirmAction(null); }}
          onCancel={() => { setConfirmOpen(false); setConfirmAction(null); }} />
      )}
    </div>
  );
};
