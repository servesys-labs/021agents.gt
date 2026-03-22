import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, TextInput } from "@tremor/react";
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
        <Card>
          <Text className="text-gray-500">Policies</Text>
          <Text className="text-3xl font-bold">{policies.length}</Text>
        </Card>
        <Card>
          <Text className="text-gray-500">Secrets</Text>
          <Text className="text-3xl font-bold">{secrets.length}</Text>
        </Card>
        <Card>
          <Text className="text-gray-500">Recent Audit Events</Text>
          <Text className="text-3xl font-bold">{events.length}</Text>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <Text className="font-semibold mb-3">Policy Templates</Text>
          <QueryState
            loading={policiesQuery.loading}
            error={policiesQuery.error}
            isEmpty={policies.length === 0}
            emptyMessage="No policies defined."
          >
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Scope</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {policies.map((policy) => (
                  <TableRow key={policy.policy_id}>
                    <TableCell><Text>{policy.name ?? "unnamed"}</Text></TableCell>
                    <TableCell><Badge>{policy.org_id ? "org" : "global"}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </QueryState>
        </Card>

        <Card>
          <Text className="font-semibold mb-3">Secrets</Text>
          <div className="mb-3 grid gap-2 md:grid-cols-3">
            <TextInput value={secretName} onChange={(event) => setSecretName(event.target.value)} placeholder="SECRET_NAME" />
            <TextInput value={secretValue} onChange={(event) => setSecretValue(event.target.value)} placeholder="secret value" />
            <Button size="xs" onClick={() => void createSecret()}>Create Secret</Button>
          </div>
          {actionMessage ? <Text className="text-emerald-600 mb-2">{actionMessage}</Text> : null}
          {actionError ? <Text className="text-red-600 mb-2">{actionError}</Text> : null}
          <QueryState
            loading={secretsQuery.loading}
            error={secretsQuery.error}
            isEmpty={secrets.length === 0}
            emptyMessage="No secrets configured."
          >
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Project</TableHeaderCell>
                  <TableHeaderCell>Env</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {secrets.map((secret) => (
                  <TableRow key={`${secret.name}-${secret.project_id}-${secret.env}`}>
                    <TableCell><Text>{secret.name ?? "secret"}</Text></TableCell>
                    <TableCell><Badge>{secret.project_id || "org"}</Badge></TableCell>
                    <TableCell><Badge>{secret.env || "all"}</Badge></TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        {secret.name ? (
                          <>
                            <Button size="xs" variant="secondary" onClick={() => void rotateSecret(secret.name ?? "")}>Rotate</Button>
                            <Button size="xs" color="red" onClick={() => setPendingDeleteSecretName(secret.name ?? "")}>Delete</Button>
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </QueryState>
        </Card>
      </div>

      <Card className="mt-6">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Text className="font-semibold">Audit Trail</Text>
          <TextInput value={auditFilter} onChange={(event) => setAuditFilter(event.target.value)} placeholder="filter by action" />
          <input
            className="w-24 rounded-md border border-gray-300 px-2 py-1 text-sm"
            type="number"
            min={1}
            value={auditSinceDays}
            onChange={(event) => setAuditSinceDays(Number(event.target.value) || 1)}
          />
          <Button size="xs" variant="secondary" onClick={() => void auditQuery.refetch()}>Filter</Button>
          <Button size="xs" onClick={() => void exportAudit()}>Export JSON</Button>
        </div>
        <QueryState
          loading={auditQuery.loading}
          error={auditQuery.error}
          isEmpty={events.length === 0}
          emptyMessage="No audit events yet."
        >
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Event</TableHeaderCell>
                <TableHeaderCell>Resource</TableHeaderCell>
                <TableHeaderCell>User</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {events.map((event, index) => (
                <TableRow key={`${event.action}-${event.created_at}-${index}`}>
                  <TableCell><Text>{event.action ?? "unknown"}</Text></TableCell>
                  <TableCell><Text>{event.resource_type ?? "n/a"}</Text></TableCell>
                  <TableCell><Text className="font-mono text-xs">{event.user_id ?? "system"}</Text></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </QueryState>
      </Card>
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
