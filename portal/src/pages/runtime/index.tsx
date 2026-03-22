import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text } from "@tremor/react";
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
        <Card className="mb-4">
          <Text>{actionMessage}</Text>
        </Card>
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
          <Card>
            <Text className="mb-3 font-semibold">Workflows</Text>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Description</TableHeaderCell>
                  <TableHeaderCell>ID</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {workflows.map((workflow) => (
                  <TableRow key={workflow.workflow_id}>
                    <TableCell><Text>{workflow.name ?? "Unnamed"}</Text></TableCell>
                    <TableCell><Text>{workflow.description ?? "No description"}</Text></TableCell>
                    <TableCell><Text className="font-mono text-xs">{workflow.workflow_id}</Text></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          <Card>
            <Text className="mb-3 font-semibold">Jobs</Text>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Job</TableHeaderCell>
                  <TableHeaderCell>Agent</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Action</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.job_id}>
                    <TableCell>
                      <Text className="font-mono text-xs">{job.job_id}</Text>
                    </TableCell>
                    <TableCell><Text>{job.agent_name ?? "n/a"}</Text></TableCell>
                    <TableCell>
                      <Badge color={job.status === "failed" || job.status === "dead" ? "red" : "blue"}>
                        {job.status ?? "unknown"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {job.job_id ? (
                        <Button size="xs" onClick={() => void retryJob(job.job_id as string)}>
                          Retry
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      </QueryState>
    </div>
  );
};
