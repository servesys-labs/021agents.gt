import { useState } from "react";

import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { useToast } from "../../components/common/ToastProvider";
import { apiRequest, useApiQuery } from "../../lib/api";
import { isPositiveInteger, isRequired } from "../../lib/validation";

type GpuEndpoint = { endpoint_id?: string; model_id?: string; gpu_type?: string; status?: string };
type RetentionPolicy = { policy_id?: string; resource_type?: string; retention_days?: number };

export const InfrastructurePage = () => {
  const { showToast } = useToast();
  const [modelId, setModelId] = useState("meta-llama/Llama-3.3-70B-Instruct");
  const [gpuType, setGpuType] = useState("h200");
  const [gpuCount, setGpuCount] = useState("1");
  const [resourceType, setResourceType] = useState("sessions");
  const [retentionDays, setRetentionDays] = useState("90");
  const [message, setMessage] = useState("");
  const [pendingEndpointId, setPendingEndpointId] = useState<string | null>(null);
  const [pendingPolicyId, setPendingPolicyId] = useState<string | null>(null);

  const gpuQuery = useApiQuery<{ endpoints: GpuEndpoint[] }>("/api/v1/gpu/endpoints");
  const retentionQuery = useApiQuery<{ policies: RetentionPolicy[] }>("/api/v1/retention");

  const refresh = async () => {
    await gpuQuery.refetch();
    await retentionQuery.refetch();
  };

  const provisionGpu = async () => {
    if (!isRequired(modelId)) {
      showToast("Model id is required.", "error");
      return;
    }
    if (!isPositiveInteger(gpuCount)) {
      showToast("GPU count must be a positive integer.", "error");
      return;
    }
    try {
      const path = `/api/v1/gpu/endpoints?model_id=${encodeURIComponent(modelId)}&gpu_type=${encodeURIComponent(gpuType)}&gpu_count=${encodeURIComponent(gpuCount)}`;
      await apiRequest(path, "POST");
      setMessage("GPU endpoint provisioning requested.");
      showToast("GPU endpoint provisioning requested.", "success");
      await gpuQuery.refetch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to provision GPU endpoint";
      setMessage(msg);
      showToast(msg, "error");
    }
  };

  const terminateGpu = async (endpointId: string) => {
    try {
      await apiRequest(`/api/v1/gpu/endpoints/${encodeURIComponent(endpointId)}`, "DELETE");
      await gpuQuery.refetch();
      showToast(`Endpoint ${endpointId} terminated.`, "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to terminate endpoint";
      setMessage(msg);
      showToast(msg, "error");
    }
  };

  const createRetention = async () => {
    if (!isRequired(resourceType)) {
      showToast("Resource type is required.", "error");
      return;
    }
    if (!isPositiveInteger(retentionDays)) {
      showToast("Retention days must be a positive integer.", "error");
      return;
    }
    try {
      const path = `/api/v1/retention?resource_type=${encodeURIComponent(resourceType)}&retention_days=${encodeURIComponent(retentionDays)}`;
      await apiRequest(path, "POST");
      setMessage("Retention policy created.");
      showToast("Retention policy created.", "success");
      await retentionQuery.refetch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create retention policy";
      setMessage(msg);
      showToast(msg, "error");
    }
  };

  const deletePolicy = async (policyId: string) => {
    try {
      await apiRequest(`/api/v1/retention/${encodeURIComponent(policyId)}`, "DELETE");
      await retentionQuery.refetch();
      showToast(`Policy ${policyId} deleted.`, "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete retention policy";
      setMessage(msg);
      showToast(msg, "error");
    }
  };

  const applyRetention = async () => {
    try {
      await apiRequest("/api/v1/retention/apply", "POST");
      setMessage("Retention policies applied.");
      showToast("Retention policies applied.", "success");
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to apply retention";
      setMessage(msg);
      showToast(msg, "error");
    }
  };

  return (
    <div>
      <PageHeader title="Infrastructure & Retention" subtitle="GPU provisioning and data retention lifecycle controls" />
      <div className="card mb-6">
        <span className="text-gray-400">{message}</span>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card">
          <p className="font-semibold text-white mb-3">GPU Endpoint Provisioning</p>
          <div className="grid gap-2 md:grid-cols-4">
            <input className="input-field" value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="model id" />
            <input className="input-field" value={gpuType} onChange={(event) => setGpuType(event.target.value)} placeholder="h200" />
            <input className="input-field" value={gpuCount} onChange={(event) => setGpuCount(event.target.value)} placeholder="1" />
            <button className="btn-primary" onClick={() => void provisionGpu()}>Provision</button>
          </div>
          <QueryState loading={gpuQuery.loading} error={gpuQuery.error} isEmpty={(gpuQuery.data?.endpoints ?? []).length === 0}>
            <table className="os-table mt-3">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(gpuQuery.data?.endpoints ?? []).map((endpoint, index) => (
                  <tr key={`${endpoint.endpoint_id}-${index}`}>
                    <td><span className="text-gray-400">{endpoint.endpoint_id}</span></td>
                    <td><span className="text-gray-400">{endpoint.model_id}</span></td>
                    <td><span className="text-gray-400">{endpoint.status}</span></td>
                    <td>
                      {endpoint.endpoint_id ? (
                        <button className="btn-danger text-xs" onClick={() => setPendingEndpointId(endpoint.endpoint_id ?? null)}>Terminate</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>
        <div className="card">
          <p className="font-semibold text-white mb-3">Retention Policies</p>
          <div className="grid gap-2 md:grid-cols-3">
            <input className="input-field" value={resourceType} onChange={(event) => setResourceType(event.target.value)} placeholder="sessions" />
            <input className="input-field" value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)} placeholder="90" />
            <button className="btn-primary" onClick={() => void createRetention()}>Create Policy</button>
          </div>
          <button className="btn-secondary text-xs mt-3" onClick={() => void applyRetention()}>Apply Retention</button>
          <QueryState loading={retentionQuery.loading} error={retentionQuery.error} isEmpty={(retentionQuery.data?.policies ?? []).length === 0}>
            <table className="os-table mt-3">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Days</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(retentionQuery.data?.policies ?? []).map((policy, index) => (
                  <tr key={`${policy.policy_id}-${index}`}>
                    <td><span className="text-gray-400">{policy.resource_type}</span></td>
                    <td><span className="text-gray-400">{policy.retention_days}</span></td>
                    <td>
                      {policy.policy_id ? (
                        <button className="btn-danger text-xs" onClick={() => setPendingPolicyId(policy.policy_id ?? null)}>Delete</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>
      </div>
      <ConfirmDialog
        open={pendingEndpointId !== null}
        title="Terminate GPU endpoint?"
        description={pendingEndpointId ? `Endpoint ${pendingEndpointId} will be shut down and billed accordingly.` : "This action cannot be undone."}
        confirmLabel="Terminate"
        tone="danger"
        onCancel={() => setPendingEndpointId(null)}
        onConfirm={() => {
          const id = pendingEndpointId;
          setPendingEndpointId(null);
          if (id) {
            void terminateGpu(id);
          }
        }}
      />
      <ConfirmDialog
        open={pendingPolicyId !== null}
        title="Delete retention policy?"
        description={pendingPolicyId ? `Policy ${pendingPolicyId} will be removed.` : "This action cannot be undone."}
        confirmLabel="Delete"
        tone="danger"
        onCancel={() => setPendingPolicyId(null)}
        onConfirm={() => {
          const id = pendingPolicyId;
          setPendingPolicyId(null);
          if (id) {
            void deletePolicy(id);
          }
        }}
      />
    </div>
  );
};
