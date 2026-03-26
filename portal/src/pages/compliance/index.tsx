import { useMemo, useState } from "react";
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Plus,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { Tabs } from "../../components/common/Tabs";
import { EmptyState } from "../../components/common/EmptyState";
import { SlidePanel } from "../../components/common/SlidePanel";
import { StatusBadge } from "../../components/common/StatusBadge";
import { useApiQuery, apiRequest } from "../../lib/api";
import { useToast } from "../../components/common/ToastProvider";

/* ── Types ─────────────────────────────────────────────────────── */

type GoldImage = {
  image_id: string;
  name: string;
  description?: string;
  version?: string;
  category?: string;
  config_hash?: string;
  is_active?: number;
  approved_by?: string;
  approved_at?: number;
  created_at?: number;
  config?: Record<string, unknown>;
};

type ComplianceCheck = {
  id: number;
  agent_name: string;
  image_id: string;
  image_name: string;
  status: string;
  drift_count: number;
  drift_fields: string[];
  drift_details?: Record<string, unknown>;
  checked_by?: string;
  created_at?: number;
};

type AuditEntry = {
  id: number;
  agent_name: string;
  action: string;
  field_changed: string;
  old_value: string;
  new_value: string;
  changed_by: string;
  created_at: number;
};

/* ── Helpers ───────────────────────────────────────────────────── */

const statusIcon = (s: string) => {
  switch (s) {
    case "compliant": return <ShieldCheck size={14} className="text-status-live" />;
    case "drifted": return <ShieldAlert size={14} className="text-status-warning" />;
    case "critical": return <ShieldX size={14} className="text-status-error" />;
    default: return <Shield size={14} className="text-text-muted" />;
  }
};

const statusColor = (s: string) => {
  switch (s) {
    case "compliant": return "text-status-live";
    case "drifted": return "text-status-warning";
    case "critical": return "text-status-error";
    default: return "text-text-muted";
  }
};

/* ── Main Page ─────────────────────────────────────────────────── */

export const CompliancePage = () => {
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState(0);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createAgent, setCreateAgent] = useState("");

  const imagesQuery = useApiQuery<{ images: GoldImage[] }>("/api/v1/gold-images");
  const checksQuery = useApiQuery<{ checks: ComplianceCheck[] }>("/api/v1/gold-images/compliance/checks");
  const summaryQuery = useApiQuery<{
    total_checks: number;
    compliant: number;
    drifted: number;
    critical: number;
    compliance_rate: number;
  }>("/api/v1/gold-images/compliance/summary");
  const auditQuery = useApiQuery<{ entries: AuditEntry[] }>("/api/v1/gold-images/audit");
  const imageDetailQuery = useApiQuery<GoldImage>(
    `/api/v1/gold-images/${selectedImage ?? ""}`,
    Boolean(selectedImage),
  );

  const images = useMemo(() => imagesQuery.data?.images ?? [], [imagesQuery.data]);
  const checks = useMemo(() => checksQuery.data?.checks ?? [], [checksQuery.data]);
  const summary = summaryQuery.data;
  const audit = useMemo(() => auditQuery.data?.entries ?? [], [auditQuery.data]);

  const handleRefresh = () => {
    imagesQuery.refetch();
    checksQuery.refetch();
    summaryQuery.refetch();
    auditQuery.refetch();
  };

  const handleCreateFromAgent = async () => {
    if (!createAgent.trim()) return;
    try {
      await apiRequest(`/api/v1/gold-images/from-agent/${encodeURIComponent(createAgent)}`, "POST");
      showToast("Gold image created", "success");
      setCreateOpen(false);
      setCreateAgent("");
      handleRefresh();
    } catch {
      showToast("Failed to create gold image", "error");
    }
  };

  const handleApprove = async (imageId: string) => {
    try {
      await apiRequest(`/api/v1/gold-images/${imageId}/approve`, "POST");
      showToast("Gold image approved", "success");
      handleRefresh();
    } catch {
      showToast("Failed to approve", "error");
    }
  };

  const handleDelete = async (imageId: string) => {
    try {
      await apiRequest(`/api/v1/gold-images/${imageId}`, "DELETE");
      showToast("Gold image deleted", "success");
      handleRefresh();
    } catch {
      showToast("Failed to delete", "error");
    }
  };

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Config Compliance"
        subtitle="Gold images, drift detection, and configuration audit"
        actions={
          <div className="flex items-center gap-2">
            <button onClick={() => setCreateOpen(!createOpen)} className="btn btn-primary text-xs">
              <Plus size={14} /> Create Gold Image
            </button>
            <button onClick={handleRefresh} className="btn btn-secondary">
              <RefreshCw size={14} />
            </button>
          </div>
        }
      />

      {/* Create dialog */}
      {createOpen && (
        <div className="card mb-4">
          <h3 className="text-sm font-medium text-text-primary mb-3">Create Gold Image from Agent</h3>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Agent name..."
              value={createAgent}
              onChange={(e) => setCreateAgent(e.target.value)}
              className="flex-1 px-3 py-2 text-xs rounded-lg bg-surface-raised border border-border-default text-text-primary"
            />
            <button onClick={handleCreateFromAgent} className="btn btn-primary text-xs" disabled={!createAgent.trim()}>
              Create
            </button>
            <button onClick={() => setCreateOpen(false)} className="btn btn-secondary text-xs">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Summary KPIs */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="card flex items-center gap-3">
            <div className="p-2 rounded-lg bg-chart-blue/10"><Shield size={16} className="text-chart-blue" /></div>
            <div>
              <p className="text-lg font-semibold text-text-primary">{images.length}</p>
              <p className="text-[10px] text-text-muted uppercase">Gold Images</p>
            </div>
          </div>
          <div className="card flex items-center gap-3">
            <div className="p-2 rounded-lg bg-status-live/10"><CheckCircle size={16} className="text-status-live" /></div>
            <div>
              <p className="text-lg font-semibold text-text-primary">{summary.compliant}</p>
              <p className="text-[10px] text-text-muted uppercase">Compliant</p>
            </div>
          </div>
          <div className="card flex items-center gap-3">
            <div className="p-2 rounded-lg bg-status-warning/10"><AlertTriangle size={16} className="text-status-warning" /></div>
            <div>
              <p className="text-lg font-semibold text-text-primary">{summary.drifted}</p>
              <p className="text-[10px] text-text-muted uppercase">Drifted</p>
            </div>
          </div>
          <div className="card flex items-center gap-3">
            <div className="p-2 rounded-lg bg-chart-purple/10"><ShieldCheck size={16} className="text-chart-purple" /></div>
            <div>
              <p className="text-lg font-semibold text-text-primary">{Math.round(summary.compliance_rate * 100)}%</p>
              <p className="text-[10px] text-text-muted uppercase">Compliance Rate</p>
            </div>
          </div>
        </div>
      )}

      <Tabs
        tabs={["Gold Images", "Compliance Checks", "Audit Log"]}
        activeIndex={activeTab}
        onChange={setActiveTab}
      />

      {/* Tab: Gold Images */}
      {activeTab === 0 && (
        <QueryState loading={imagesQuery.loading} error={imagesQuery.error}>
          {images.length > 0 ? (
            <div className="card mt-4">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-default text-text-muted">
                      <th className="text-left py-2 pr-4">Name</th>
                      <th className="text-left py-2 px-3">Version</th>
                      <th className="text-left py-2 px-3">Category</th>
                      <th className="text-left py-2 px-3">Hash</th>
                      <th className="text-center py-2 px-3">Approved</th>
                      <th className="text-center py-2 px-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {images.map((img) => (
                      <tr key={img.image_id} className="border-b border-border-default/50 hover:bg-surface-overlay/30">
                        <td className="py-2 pr-4">
                          <button
                            className="text-text-primary hover:text-accent text-xs font-medium"
                            onClick={() => { setSelectedImage(img.image_id); setDrawerOpen(true); }}
                          >
                            {img.name}
                          </button>
                          <p className="text-[10px] text-text-muted font-mono">{img.image_id}</p>
                        </td>
                        <td className="py-2 px-3 text-text-secondary">{img.version}</td>
                        <td className="py-2 px-3">
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-surface-overlay text-text-secondary">
                            {img.category}
                          </span>
                        </td>
                        <td className="py-2 px-3 font-mono text-text-muted text-[10px]">{img.config_hash}</td>
                        <td className="py-2 px-3 text-center">
                          {img.approved_by ? (
                            <CheckCircle size={14} className="text-status-live mx-auto" />
                          ) : (
                            <span className="text-text-muted text-[10px]">pending</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center space-x-2">
                          {!img.approved_by && (
                            <button
                              onClick={() => handleApprove(img.image_id)}
                              className="text-status-live hover:underline text-[10px]"
                            >
                              Approve
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(img.image_id)}
                            className="text-status-error hover:underline text-[10px]"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState message="No gold images yet. Create one from an existing agent." />
          )}
        </QueryState>
      )}

      {/* Tab: Compliance Checks */}
      {activeTab === 1 && (
        <QueryState loading={checksQuery.loading} error={checksQuery.error}>
          {checks.length > 0 ? (
            <div className="card mt-4">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-default text-text-muted">
                      <th className="text-left py-2 pr-4">Agent</th>
                      <th className="text-left py-2 px-3">Gold Image</th>
                      <th className="text-center py-2 px-3">Status</th>
                      <th className="text-right py-2 px-3">Drifts</th>
                      <th className="text-left py-2 px-3">Drifted Fields</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((c) => (
                      <tr key={c.id} className="border-b border-border-default/50 hover:bg-surface-overlay/30">
                        <td className="py-2 pr-4 text-text-primary">{c.agent_name}</td>
                        <td className="py-2 px-3 text-text-secondary">{c.image_name || c.image_id?.slice(0, 12)}</td>
                        <td className="py-2 px-3 text-center">
                          <span className={`inline-flex items-center gap-1 ${statusColor(c.status)}`}>
                            {statusIcon(c.status)}
                            <span className="text-[10px]">{c.status}</span>
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right">
                          <span className={c.drift_count > 0 ? "text-status-warning" : "text-text-muted"}>
                            {c.drift_count}
                          </span>
                        </td>
                        <td className="py-2 px-3">
                          <div className="flex flex-wrap gap-1">
                            {(c.drift_fields ?? []).slice(0, 4).map((f) => (
                              <span key={f} className="px-1.5 py-0.5 rounded text-[10px] bg-surface-overlay text-text-secondary">
                                {f}
                              </span>
                            ))}
                            {(c.drift_fields ?? []).length > 4 && (
                              <span className="text-[10px] text-text-muted">+{c.drift_fields.length - 4}</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState message="No compliance checks yet. Run a check from the API or CLI." />
          )}
        </QueryState>
      )}

      {/* Tab: Audit Log */}
      {activeTab === 2 && (
        <QueryState loading={auditQuery.loading} error={auditQuery.error}>
          {audit.length > 0 ? (
            <div className="card mt-4">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-default text-text-muted">
                      <th className="text-left py-2 pr-4">Action</th>
                      <th className="text-left py-2 px-3">Agent</th>
                      <th className="text-left py-2 px-3">Field</th>
                      <th className="text-left py-2 px-3">Old Value</th>
                      <th className="text-left py-2 px-3">New Value</th>
                      <th className="text-left py-2 px-3">Changed By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((e) => (
                      <tr key={e.id} className="border-b border-border-default/50 hover:bg-surface-overlay/30">
                        <td className="py-2 pr-4">
                          <StatusBadge status={e.action.includes("approved") ? "success" : e.action.includes("deleted") ? "error" : "info"} />
                          <span className="ml-1.5 text-text-secondary">{e.action}</span>
                        </td>
                        <td className="py-2 px-3 text-text-muted">{e.agent_name || "—"}</td>
                        <td className="py-2 px-3 text-text-muted font-mono">{e.field_changed || "—"}</td>
                        <td className="py-2 px-3 text-text-muted truncate max-w-[120px]">{e.old_value || "—"}</td>
                        <td className="py-2 px-3 text-text-muted truncate max-w-[120px]">{e.new_value || "—"}</td>
                        <td className="py-2 px-3 text-text-muted">{e.changed_by || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState message="No config audit entries yet." />
          )}
        </QueryState>
      )}

      {/* Detail Drawer */}
      <SlidePanel
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setSelectedImage(null); }}
        title={`Gold Image — ${imageDetailQuery.data?.name ?? ""}`}
      >
        {selectedImage && (
          <QueryState loading={imageDetailQuery.loading} error={imageDetailQuery.error}>
            {imageDetailQuery.data && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-text-muted">ID</span>
                    <span className="font-mono text-text-secondary">{imageDetailQuery.data.image_id}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-text-muted">Version</span>
                    <span className="text-text-secondary">{imageDetailQuery.data.version}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-text-muted">Category</span>
                    <span className="text-text-secondary">{imageDetailQuery.data.category}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-text-muted">Hash</span>
                    <span className="font-mono text-text-secondary">{imageDetailQuery.data.config_hash}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-text-muted">Approved</span>
                    <span className="text-text-secondary">{imageDetailQuery.data.approved_by || "Not yet"}</span>
                  </div>
                </div>
                {imageDetailQuery.data.description && (
                  <div>
                    <p className="text-xs text-text-muted mb-1">Description</p>
                    <p className="text-xs text-text-secondary">{imageDetailQuery.data.description}</p>
                  </div>
                )}
                <div>
                  <p className="text-xs text-text-muted mb-1">Config</p>
                  <pre className="text-[10px] text-text-secondary bg-surface-base rounded-lg p-3 overflow-auto max-h-80 border border-border-default">
                    {JSON.stringify(imageDetailQuery.data.config, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </QueryState>
        )}
      </SlidePanel>
    </div>
  );
};
