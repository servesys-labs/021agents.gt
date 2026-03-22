import { useGetIdentity } from "@refinedev/core";
import { useState } from "react";

import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { useToast } from "../../components/common/ToastProvider";
import { safeArray } from "../../lib/adapters";
import { apiRequest, useApiQuery } from "../../lib/api";
import { isRequired, parseScopes } from "../../lib/validation";

type ApiKey = {
  key_id: string;
  name: string;
  key_prefix: string;
  scopes?: string[];
  is_active?: boolean;
};

type Organization = {
  org_id: string;
  name: string;
  plan?: string;
  member_count?: number;
};

export const SettingsPage = () => {
  const { data: identity } = useGetIdentity<{ name: string; email: string }>();
  const { showToast } = useToast();
  const [newKeyName, setNewKeyName] = useState("portal-key");
  const [keyScope, setKeyScope] = useState("*");
  const [createdKey, setCreatedKey] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingRevokeKeyId, setPendingRevokeKeyId] = useState<string | null>(null);

  const keysQuery = useApiQuery<ApiKey[]>("/api/v1/api-keys");
  const orgsQuery = useApiQuery<Organization[]>("/api/v1/orgs");
  const keys = safeArray<ApiKey>(keysQuery.data);
  const orgs = safeArray<Organization>(orgsQuery.data);

  const createApiKey = async () => {
    setCreatedKey("");
    setActionError("");
    if (!isRequired(newKeyName)) {
      const message = "Key name is required.";
      setActionError(message);
      showToast(message, "error");
      return;
    }
    const scopes = parseScopes(keyScope);
    if (scopes.length === 0) {
      const message = "At least one scope is required.";
      setActionError(message);
      showToast(message, "error");
      return;
    }
    try {
      const payload = await apiRequest<{ key: string }>("/api/v1/api-keys", "POST", {
        name: newKeyName,
        scopes,
      });
      setCreatedKey(payload.key);
      await keysQuery.refetch();
      showToast("API key created successfully.", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create key";
      setActionError(message);
      showToast(message, "error");
    }
  };

  const revokeApiKey = async (keyId: string) => {
    try {
      await apiRequest(`/api/v1/api-keys/${encodeURIComponent(keyId)}`, "DELETE");
      await keysQuery.refetch();
      showToast("API key revoked.", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to revoke key";
      setActionError(message);
      showToast(message, "error");
    }
  };

  const rotateApiKey = async (keyId: string) => {
    try {
      const payload = await apiRequest<{ key: string }>(`/api/v1/api-keys/${encodeURIComponent(keyId)}/rotate`, "POST");
      setCreatedKey(payload.key);
      await keysQuery.refetch();
      showToast("API key rotated.", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rotate key";
      setActionError(message);
      showToast(message, "error");
    }
  };

  return (
    <div>
      <PageHeader title="Settings" subtitle="Identity, organizations, and API credentials" />

      <div className="card mb-6">
        <p className="font-bold text-white mb-2">Profile</p>
        <span className="text-gray-400">Email: {identity?.email}</span>
        <span className="text-gray-400">Name: {identity?.name || "(not set)"}</span>
      </div>

      <QueryState
        loading={orgsQuery.loading}
        error={orgsQuery.error}
        isEmpty={orgs.length === 0}
        emptyMessage="No organizations available."
        onRetry={() => void orgsQuery.refetch()}
      >
        <div className="card mb-6">
          <p className="font-bold text-white mb-2">Organizations</p>
          <table className="os-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Plan</th>
                <th>Members</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((org) => (
                <tr key={org.org_id}>
                  <td><span className="font-medium text-white">{org.name}</span></td>
                  <td><span className="badge">{org.plan ?? "free"}</span></td>
                  <td><span className="text-gray-400">{org.member_count ?? 0}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>

      <QueryState
        loading={keysQuery.loading}
        error={keysQuery.error}
        isEmpty={keys.length === 0}
        emptyMessage="No API keys created yet."
        onRetry={() => void keysQuery.refetch()}
      >
        <div className="card">
          <div className="flex justify-between mb-2">
            <p className="font-bold text-white">API Keys</p>
            <span className="text-xs text-gray-500">{keys.length} key(s)</span>
          </div>
          <div className="mb-4 grid gap-2 md:grid-cols-3">
            <input className="input-field" value={newKeyName} onChange={(event) => setNewKeyName(event.target.value)} placeholder="Key name" />
            <input className="input-field" value={keyScope} onChange={(event) => setKeyScope(event.target.value)} placeholder="Scopes e.g. * or agents:read" />
            <button className="btn-primary" onClick={() => void createApiKey()}>Create Key</button>
          </div>
          {createdKey ? (
            <p className="text-emerald-400 mb-3 break-all">Created/rotated key: {createdKey}</p>
          ) : null}
          {actionError ? (
            <span className="text-red-600 mb-3">{actionError}</span>
          ) : null}
          <table className="os-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Scopes</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.key_id}>
                  <td><span className="text-gray-400">{key.name}</span></td>
                  <td><span className="font-mono text-xs text-gray-300">{key.key_prefix}...</span></td>
                  <td>
                    <div className="flex gap-1">
                      {safeArray<string>(key.scopes).slice(0, 3).map((scope) => (
                        <span key={scope} className="badge badge-muted">{scope}</span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <span className="badge">
                      {key.is_active ? "Active" : "Revoked"}
                    </span>
                  </td>
                  <td>
                    <div className="flex gap-2">
                      {key.is_active ? (
                        <>
                          <button className="btn-secondary text-xs" onClick={() => void rotateApiKey(key.key_id)}>
                            Rotate
                          </button>
                          <button className="btn-danger text-xs" onClick={() => setPendingRevokeKeyId(key.key_id)}>
                            Revoke
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
      <ConfirmDialog
        open={pendingRevokeKeyId !== null}
        title="Revoke API key?"
        description={`This key will stop working immediately.${pendingRevokeKeyId ? ` (${pendingRevokeKeyId})` : ""}`}
        confirmLabel="Revoke"
        tone="danger"
        onCancel={() => setPendingRevokeKeyId(null)}
        onConfirm={() => {
          const keyId = pendingRevokeKeyId;
          setPendingRevokeKeyId(null);
          if (keyId) {
            void revokeApiKey(keyId);
          }
        }}
      />
    </div>
  );
};
