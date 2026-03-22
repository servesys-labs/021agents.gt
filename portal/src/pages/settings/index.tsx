import { useGetIdentity } from "@refinedev/core";
import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, TextInput } from "@tremor/react";
import { useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { safeArray } from "../../lib/adapters";
import { apiRequest, useApiQuery } from "../../lib/api";

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
  const [newKeyName, setNewKeyName] = useState("portal-key");
  const [keyScope, setKeyScope] = useState("*");
  const [createdKey, setCreatedKey] = useState("");
  const [actionError, setActionError] = useState("");

  const keysQuery = useApiQuery<ApiKey[]>("/api/v1/api-keys");
  const orgsQuery = useApiQuery<Organization[]>("/api/v1/orgs");
  const keys = safeArray<ApiKey>(keysQuery.data);
  const orgs = safeArray<Organization>(orgsQuery.data);

  const createApiKey = async () => {
    setCreatedKey("");
    setActionError("");
    try {
      const payload = await apiRequest<{ key: string }>("/api/v1/api-keys", "POST", {
        name: newKeyName,
        scopes: keyScope.split(",").map((item) => item.trim()).filter(Boolean),
      });
      setCreatedKey(payload.key);
      await keysQuery.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to create key");
    }
  };

  const revokeApiKey = async (keyId: string) => {
    if (!window.confirm(`Revoke API key ${keyId}?`)) {
      return;
    }
    try {
      await apiRequest(`/api/v1/api-keys/${encodeURIComponent(keyId)}`, "DELETE");
      await keysQuery.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to revoke key");
    }
  };

  const rotateApiKey = async (keyId: string) => {
    try {
      const payload = await apiRequest<{ key: string }>(`/api/v1/api-keys/${encodeURIComponent(keyId)}/rotate`, "POST");
      setCreatedKey(payload.key);
      await keysQuery.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to rotate key");
    }
  };

  return (
    <div>
      <PageHeader title="Settings" subtitle="Identity, organizations, and API credentials" />

      <Card className="mb-6">
        <Text className="font-bold mb-2">Profile</Text>
        <Text>Email: {identity?.email}</Text>
        <Text>Name: {identity?.name || "(not set)"}</Text>
      </Card>

      <QueryState
        loading={orgsQuery.loading}
        error={orgsQuery.error}
        isEmpty={orgs.length === 0}
        emptyMessage="No organizations available."
        onRetry={() => void orgsQuery.refetch()}
      >
        <Card className="mb-6">
          <Text className="font-bold mb-2">Organizations</Text>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Plan</TableHeaderCell>
                <TableHeaderCell>Members</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {orgs.map((org) => (
                <TableRow key={org.org_id}>
                  <TableCell><Text className="font-medium">{org.name}</Text></TableCell>
                  <TableCell><Badge>{org.plan ?? "free"}</Badge></TableCell>
                  <TableCell><Text>{org.member_count ?? 0}</Text></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </QueryState>

      <QueryState
        loading={keysQuery.loading}
        error={keysQuery.error}
        isEmpty={keys.length === 0}
        emptyMessage="No API keys created yet."
        onRetry={() => void keysQuery.refetch()}
      >
        <Card>
          <div className="flex justify-between mb-2">
            <Text className="font-bold">API Keys</Text>
            <Text className="text-xs text-gray-400">{keys.length} key(s)</Text>
          </div>
          <div className="mb-4 grid gap-2 md:grid-cols-3">
            <TextInput value={newKeyName} onChange={(event) => setNewKeyName(event.target.value)} placeholder="Key name" />
            <TextInput value={keyScope} onChange={(event) => setKeyScope(event.target.value)} placeholder="Scopes e.g. * or agents:read" />
            <Button onClick={() => void createApiKey()}>Create Key</Button>
          </div>
          {createdKey ? (
            <Text className="text-emerald-600 mb-3 break-all">Created/rotated key: {createdKey}</Text>
          ) : null}
          {actionError ? (
            <Text className="text-red-600 mb-3">{actionError}</Text>
          ) : null}
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Prefix</TableHeaderCell>
                <TableHeaderCell>Scopes</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key.key_id}>
                  <TableCell><Text>{key.name}</Text></TableCell>
                  <TableCell><Text className="font-mono text-xs">{key.key_prefix}...</Text></TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {safeArray<string>(key.scopes).slice(0, 3).map((scope) => (
                        <Badge key={scope} size="xs">{scope}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge color={key.is_active ? "green" : "red"}>
                      {key.is_active ? "Active" : "Revoked"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      {key.is_active ? (
                        <>
                          <Button size="xs" variant="secondary" onClick={() => void rotateApiKey(key.key_id)}>
                            Rotate
                          </Button>
                          <Button size="xs" color="red" onClick={() => void revokeApiKey(key.key_id)}>
                            Revoke
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </QueryState>
    </div>
  );
};
