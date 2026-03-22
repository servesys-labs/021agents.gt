import { Button, Card, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, TextInput } from "@tremor/react";
import { useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { apiRequest, useApiQuery } from "../../lib/api";

type GpuEndpoint = { endpoint_id?: string; model_id?: string; gpu_type?: string; status?: string };
type RetentionPolicy = { policy_id?: string; resource_type?: string; retention_days?: number };

export const InfrastructurePage = () => {
  const [modelId, setModelId] = useState("meta-llama/Llama-3.3-70B-Instruct");
  const [gpuType, setGpuType] = useState("h200");
  const [gpuCount, setGpuCount] = useState("1");
  const [resourceType, setResourceType] = useState("sessions");
  const [retentionDays, setRetentionDays] = useState("90");
  const [message, setMessage] = useState("");

  const gpuQuery = useApiQuery<{ endpoints: GpuEndpoint[] }>("/api/v1/gpu/endpoints");
  const retentionQuery = useApiQuery<{ policies: RetentionPolicy[] }>("/api/v1/retention");

  const refresh = async () => {
    await gpuQuery.refetch();
    await retentionQuery.refetch();
  };

  const provisionGpu = async () => {
    try {
      const path = `/api/v1/gpu/endpoints?model_id=${encodeURIComponent(modelId)}&gpu_type=${encodeURIComponent(gpuType)}&gpu_count=${encodeURIComponent(gpuCount)}`;
      await apiRequest(path, "POST");
      setMessage("GPU endpoint provisioning requested.");
      await gpuQuery.refetch();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to provision GPU endpoint");
    }
  };

  const terminateGpu = async (endpointId: string) => {
    if (!window.confirm(`Terminate endpoint ${endpointId}?`)) {
      return;
    }
    try {
      await apiRequest(`/api/v1/gpu/endpoints/${encodeURIComponent(endpointId)}`, "DELETE");
      await gpuQuery.refetch();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to terminate endpoint");
    }
  };

  const createRetention = async () => {
    try {
      const path = `/api/v1/retention?resource_type=${encodeURIComponent(resourceType)}&retention_days=${encodeURIComponent(retentionDays)}`;
      await apiRequest(path, "POST");
      setMessage("Retention policy created.");
      await retentionQuery.refetch();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to create retention policy");
    }
  };

  const deletePolicy = async (policyId: string) => {
    if (!window.confirm(`Delete policy ${policyId}?`)) {
      return;
    }
    try {
      await apiRequest(`/api/v1/retention/${encodeURIComponent(policyId)}`, "DELETE");
      await retentionQuery.refetch();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to delete retention policy");
    }
  };

  const applyRetention = async () => {
    try {
      await apiRequest("/api/v1/retention/apply", "POST");
      setMessage("Retention policies applied.");
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to apply retention");
    }
  };

  return (
    <div>
      <PageHeader title="Infrastructure & Retention" subtitle="GPU provisioning and data retention lifecycle controls" />
      <Card className="mb-6">
        <Text>{message}</Text>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <Text className="font-semibold mb-3">GPU Endpoint Provisioning</Text>
          <div className="grid gap-2 md:grid-cols-4">
            <TextInput value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="model id" />
            <TextInput value={gpuType} onChange={(event) => setGpuType(event.target.value)} placeholder="h200" />
            <TextInput value={gpuCount} onChange={(event) => setGpuCount(event.target.value)} placeholder="1" />
            <Button onClick={() => void provisionGpu()}>Provision</Button>
          </div>
          <QueryState loading={gpuQuery.loading} error={gpuQuery.error} isEmpty={(gpuQuery.data?.endpoints ?? []).length === 0}>
            <Table className="mt-3">
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Endpoint</TableHeaderCell>
                  <TableHeaderCell>Model</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell></TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(gpuQuery.data?.endpoints ?? []).map((endpoint, index) => (
                  <TableRow key={`${endpoint.endpoint_id}-${index}`}>
                    <TableCell><Text>{endpoint.endpoint_id}</Text></TableCell>
                    <TableCell><Text>{endpoint.model_id}</Text></TableCell>
                    <TableCell><Text>{endpoint.status}</Text></TableCell>
                    <TableCell>
                      {endpoint.endpoint_id ? (
                        <Button size="xs" color="red" onClick={() => void terminateGpu(endpoint.endpoint_id ?? "")}>Terminate</Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </QueryState>
        </Card>
        <Card>
          <Text className="font-semibold mb-3">Retention Policies</Text>
          <div className="grid gap-2 md:grid-cols-3">
            <TextInput value={resourceType} onChange={(event) => setResourceType(event.target.value)} placeholder="sessions" />
            <TextInput value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)} placeholder="90" />
            <Button onClick={() => void createRetention()}>Create Policy</Button>
          </div>
          <Button size="xs" className="mt-3" variant="secondary" onClick={() => void applyRetention()}>Apply Retention</Button>
          <QueryState loading={retentionQuery.loading} error={retentionQuery.error} isEmpty={(retentionQuery.data?.policies ?? []).length === 0}>
            <Table className="mt-3">
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Resource</TableHeaderCell>
                  <TableHeaderCell>Days</TableHeaderCell>
                  <TableHeaderCell></TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(retentionQuery.data?.policies ?? []).map((policy, index) => (
                  <TableRow key={`${policy.policy_id}-${index}`}>
                    <TableCell><Text>{policy.resource_type}</Text></TableCell>
                    <TableCell><Text>{policy.retention_days}</Text></TableCell>
                    <TableCell>
                      {policy.policy_id ? (
                        <Button size="xs" color="red" onClick={() => void deletePolicy(policy.policy_id ?? "")}>Delete</Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </QueryState>
        </Card>
      </div>
    </div>
  );
};
