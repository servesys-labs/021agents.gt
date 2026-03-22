import { useState } from "react";

import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { useToast } from "../../components/common/ToastProvider";
import { apiRequest, useApiQuery } from "../../lib/api";
import { isRequired } from "../../lib/validation";

type Policy = {
  policy_id?: string;
  name?: string;
  org_id?: string;
  created_at?: number;
};

type SecretEntry = {
  name?: string;
  project_id?: string;
  env?: string;
  created_at?: number;
  updated_at?: number;
};

type AuditEntry = {
  action?: string;
  resource_type?: string;
  user_id?: string;
  created_at?: number;
  name?: string;
};

type PolicyResponse = { policies?: Policy[] };
type SecretResponse = { secrets?: SecretEntry[] };
type AuditResponse = { entries?: AuditEntry[] };

export const GovernancePage = () => {
  const { showToast } = useToast();
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [auditFilter, setAuditFilter] = useState("");
  const [auditSinceDays, setAuditSinceDays] = useState(30);
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingDeleteSecretName, setPendingDeleteSecretName] = useState<string | null>(null);

  const policiesQuery = useApiQuery<PolicyResponse>("/api/v1/policies");
  const secretsQuery = useApiQuery<SecretResponse>("/api/v1/secrets");
  const auditQuery = useApiQuery<AuditResponse>(
    `/api/v1/audit/log?limit=50&since_days=${auditSinceDays}&action=${encodeURIComponent(auditFilter)}`,
  );

  const policies = policiesQuery.data?.policies ?? [];
  const secrets = secretsQuery.data?.secrets ?? [];
  const events = auditQuery.data?.entries ?? [];

  const createSecret = async () => {
    if (!isRequired(secretName) || !isRequired(secretValue)) {
      const message = "Secret name and value are required.";
      setActionError(message);
      showToast(message, "error");
      return;
    }
    setActionError("");
    try {
      await apiRequest("/api/v1/secrets", "POST", {
        name: secretName,
        value: secretValue,
      });
      setSecretName("");
      setSecretValue("");
      setActionMessage(`Secret ${secretName} created.`);
      showToast(`Secret ${secretName} created.`, "success");
      await secretsQuery.refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create secret";
      setActionError(message);
      showToast(message, "error");
    }
  };

  const rotateSecret = async (name: string) => {
    const newValue = window.prompt(`New value for ${name}`);
    if (!newValue) {
      return;
    }
    try {
      await apiRequest(`/api/v1/secrets/${encodeURIComponent(name)}/rotate?new_value=${encodeURIComponent(newValue)}`, "POST");
      setActionMessage(`Secret ${name} rotated.`);
      showToast(`Secret ${name} rotated.`, "success");
      await secretsQuery.refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rotate secret";
      setActionError(message);
      showToast(message, "error");
    }
  };

  const deleteSecret = async (name: string) => {
    try {
      await apiRequest(`/api/v1/secrets/${encodeURIComponent(name)}`, "DELETE");
      setActionMessage(`Secret ${name} deleted.`);
      showToast(`Secret ${name} deleted.`, "success");
      await secretsQuery.refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete secret";
      setActionError(message);
      showToast(message, "error");
    }
  };

  const exportAudit = async () => {
    try {
      const payload = await apiRequest<Record<string, unknown>>(
        `/api/v1/audit/export?since_days=${auditSinceDays}&limit=10000`,
      );
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "audit-export.json";
      link.click();
      URL.revokeObjectURL(url);
      setActionMessage("Audit export downloaded.");
      showToast("Audit export downloaded.", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to export audit log";
      setActionError(message);
      showToast(message, "error");
    }
  };

  return (
    <div>
      <PageHeader title="Governance" subtitle="Policies, secret inventory, and recent audit activity" />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card">
          <span className="text-gray-500">Policies</span>
          <p className="text-3xl font-bold text-white">{policies.length}</p>
        </div>
        <div className="card">
          <span className="text-gray-500">Secrets</span>
          <p className="text-3xl font-bold text-white">{secrets.length}</p>
        </div>
        <div className="card">
          <span className="text-gray-500">Recent Audit Events</span>
          <p className="text-3xl font-bold text-white">{events.length}</p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="card">
          <p className="font-semibold text-white mb-3">Policy Templates</p>
          <QueryState
            loading={policiesQuery.loading}
            error={policiesQuery.error}
            isEmpty={policies.length === 0}
            emptyMessage="No policies defined."
          >
            <table className="os-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Scope</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <tr key={policy.policy_id}>
                    <td><span className="text-gray-400">{policy.name ?? "unnamed"}</span></td>
                    <td><span className="badge">{policy.org_id ? "org" : "global"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>

        <div className="card">
          <p className="font-semibold text-white mb-3">Secrets</p>
          <div className="mb-3 grid gap-2 md:grid-cols-3">
            <input className="input-field" value={secretName} onChange={(event) => setSecretName(event.target.value)} placeholder="SECRET_NAME" />
            <input className="input-field" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} placeholder="secret value" />
            <button className="btn-primary text-xs" onClick={() => void createSecret()}>Create Secret</button>
          </div>
          {actionMessage ? <p className="text-emerald-400 mb-2">{actionMessage}</p> : null}
          {actionError ? <span className="text-red-600 mb-2">{actionError}</span> : null}
          <QueryState
            loading={secretsQuery.loading}
            error={secretsQuery.error}
            isEmpty={secrets.length === 0}
            emptyMessage="No secrets configured."
          >
            <table className="os-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Project</th>
                  <th>Env</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {secrets.map((secret) => (
                  <tr key={`${secret.name}-${secret.project_id}-${secret.env}`}>
                    <td><span className="text-gray-400">{secret.name ?? "secret"}</span></td>
                    <td><span className="badge">{secret.project_id || "org"}</span></td>
                    <td><span className="badge">{secret.env || "all"}</span></td>
                    <td>
                      <div className="flex gap-2">
                        {secret.name ? (
                          <>
                            <button className="btn-secondary text-xs" onClick={() => void rotateSecret(secret.name ?? "")}>Rotate</button>
                            <button className="btn-danger text-xs" onClick={() => setPendingDeleteSecretName(secret.name ?? "")}>Delete</button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>
      </div>

      <div className="card mt-6">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <p className="font-semibold text-white">Audit Trail</p>
          <input className="input-field" value={auditFilter} onChange={(event) => setAuditFilter(event.target.value)} placeholder="filter by action" />
          <input
            className="w-24 rounded-md border border-[#2a2a2a] px-2 py-1 text-sm"
            type="number"
            min={1}
            value={auditSinceDays}
            onChange={(event) => setAuditSinceDays(Number(event.target.value) || 1)}
          />
          <button className="btn-secondary text-xs" onClick={() => void auditQuery.refetch()}>Filter</button>
          <button className="btn-primary text-xs" onClick={() => void exportAudit()}>Export JSON</button>
        </div>
        <QueryState
          loading={auditQuery.loading}
          error={auditQuery.error}
          isEmpty={events.length === 0}
          emptyMessage="No audit events yet."
        >
          <table className="os-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Resource</th>
                <th>User</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event, index) => (
                <tr key={`${event.action}-${event.created_at}-${index}`}>
                  <td><span className="text-gray-400">{event.action ?? "unknown"}</span></td>
                  <td><span className="text-gray-400">{event.resource_type ?? "n/a"}</span></td>
                  <td><span className="font-mono text-xs text-gray-300">{event.user_id ?? "system"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </QueryState>
      </div>
      <ConfirmDialog
        open={pendingDeleteSecretName !== null}
        title="Delete secret?"
        description={pendingDeleteSecretName ? `This removes ${pendingDeleteSecretName} from the selected scope.` : "This action cannot be undone."}
        confirmLabel="Delete"
        tone="danger"
        onCancel={() => setPendingDeleteSecretName(null)}
        onConfirm={() => {
          const name = pendingDeleteSecretName;
          setPendingDeleteSecretName(null);
          if (name) {
            void deleteSecret(name);
          }
        }}
      />
    </div>
  );
};
