import { useCustom, useGetIdentity } from "@refinedev/core";
import { Card, Text, Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, Badge, Button } from "@tremor/react";

const API_URL = "/api/v1";
const authHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const SettingsPage = () => {
  const { data: identity } = useGetIdentity<{ name: string; email: string }>();

  const { data: keysData, refetch: refetchKeys } = useCustom({
    url: `${API_URL}/api-keys`,
    method: "get",
    config: { headers: authHeaders() },
  });

  const { data: orgsData } = useCustom({
    url: `${API_URL}/orgs`,
    method: "get",
    config: { headers: authHeaders() },
  });

  const keys = (keysData?.data || []) as any[];
  const orgs = (orgsData?.data || []) as any[];

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>

      {/* Profile */}
      <Card className="mb-6">
        <Text className="font-bold mb-2">Profile</Text>
        <Text>Email: {identity?.email}</Text>
        <Text>Name: {identity?.name || "(not set)"}</Text>
      </Card>

      {/* Organizations */}
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
            {orgs.map((org: any) => (
              <TableRow key={org.org_id}>
                <TableCell><Text className="font-medium">{org.name}</Text></TableCell>
                <TableCell><Badge>{org.plan}</Badge></TableCell>
                <TableCell><Text>{org.member_count}</Text></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* API Keys */}
      <Card>
        <div className="flex justify-between mb-2">
          <Text className="font-bold">API Keys</Text>
          <Text className="text-xs text-gray-400">{keys.length} key(s)</Text>
        </div>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Prefix</TableHeaderCell>
              <TableHeaderCell>Scopes</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {keys.map((k: any) => (
              <TableRow key={k.key_id}>
                <TableCell><Text>{k.name}</Text></TableCell>
                <TableCell><Text className="font-mono text-xs">{k.key_prefix}...</Text></TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    {(k.scopes || []).slice(0, 3).map((s: string) => (
                      <Badge key={s} size="xs">{s}</Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge color={k.is_active ? "green" : "red"}>
                    {k.is_active ? "Active" : "Revoked"}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
};
