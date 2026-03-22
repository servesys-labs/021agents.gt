import { useMemo, useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { apiRequest, useApiQuery } from "../../lib/api";

type Workflow = {
  workflow_id?: string;
  name?: string;
  description?: string;
  created_at?: number;
};

type Job = {
  job_id?: string;
  agent_name?: string;
  task?: string;
  status?: string;
  retries?: number;
};

type WorkflowResponse = { workflows?: Workflow[] };
type JobsResponse = { jobs?: Job[] };

export const RuntimePage = () => {
  const [actionMessage, setActionMessage] = useState<string>("");
  const workflowsQuery = useApiQuery<WorkflowResponse>("/api/v1/workflows");
  const jobsQuery = useApiQuery<JobsResponse>("/api/v1/jobs?limit=25");

  const workflows = useMemo(() => workflowsQuery.data?.workflows ?? [], [workflowsQuery.data]);
  const jobs = useMemo(() => jobsQuery.data?.jobs ?? [], [jobsQuery.data]);

  const retryJob = async (jobId: string) => {
    setActionMessage("");
    try {
      const result = await apiRequest<{ retried: string }>(`/api/v1/jobs/${jobId}/retry`, "POST");
      setActionMessage(`Retried job ${result.retried}`);
      await jobsQuery.refetch();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Failed to retry job");
    }
  };

  const combinedError = workflowsQuery.error ?? jobsQuery.error;
  const combinedLoading = workflowsQuery.loading || jobsQuery.loading;

  return (
    <div>
      <PageHeader title="Workflows & Jobs" subtitle="Monitor async pipelines, retries, and queue state" />

      {actionMessage ? (
        <div className="card mb-4">
          <span className="text-gray-400">{actionMessage}</span>
        </div>
      ) : null}

      <QueryState
        loading={combinedLoading}
        error={combinedError}
        isEmpty={workflows.length === 0 && jobs.length === 0}
        emptyMessage="No workflows or jobs yet."
        onRetry={() => {
          void workflowsQuery.refetch();
          void jobsQuery.refetch();
        }}
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="card">
            <span className="mb-3 font-semibold">Workflows</span>
            <table className="os-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Description</th>
                  <th>ID</th>
                </tr>
              </thead>
              <tbody>
                {workflows.map((workflow) => (
                  <tr key={workflow.workflow_id}>
                    <td><span className="text-gray-400">{workflow.name ?? "Unnamed"}</span></td>
                    <td><span className="text-gray-400">{workflow.description ?? "No description"}</span></td>
                    <td><span className="font-mono text-xs text-gray-300">{workflow.workflow_id}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <span className="mb-3 font-semibold">Jobs</span>
            <table className="os-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.job_id}>
                    <td>
                      <span className="font-mono text-xs text-gray-300">{job.job_id}</span>
                    </td>
                    <td><span className="text-gray-400">{job.agent_name ?? "n/a"}</span></td>
                    <td>
                      <span className="badge">
                        {job.status ?? "unknown"}
                      </span>
                    </td>
                    <td>
                      {job.job_id ? (
                        <button className="btn-primary text-xs" onClick={() => void retryJob(job.job_id as string)}>
                          Retry
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </QueryState>
    </div>
  );
};
