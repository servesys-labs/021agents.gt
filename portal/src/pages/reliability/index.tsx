import { Button, Card, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, TextInput } from "@tremor/react";
import { useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { apiRequest, useApiQuery } from "../../lib/api";

type Slo = { slo_id?: string; metric?: string; threshold?: number; operator?: string; current_value?: number; breached?: boolean };

export const ReliabilityPage = () => {
  const [metric, setMetric] = useState("success_rate");
  const [threshold, setThreshold] = useState("0.95");
  const [operator, setOperator] = useState("gte");
  const [windowHours, setWindowHours] = useState("24");
  const [agentName, setAgentName] = useState("");
  const [compareAgent, setCompareAgent] = useState("");
  const [versionA, setVersionA] = useState("current");
  const [versionB, setVersionB] = useState("current");
  const [compareResult, setCompareResult] = useState("");
  const [message, setMessage] = useState("");

  const slosQuery = useApiQuery<{ slos: Slo[] }>(
    `/api/v1/slos?agent_name=${encodeURIComponent(agentName)}`,
  );
  const statusQuery = useApiQuery<{ slos: Slo[]; breached_count: number }>("/api/v1/slos/status");

  const refresh = async () => {
    await slosQuery.refetch();
    await statusQuery.refetch();
  };

  const createSlo = async () => {
    try {
      const path = `/api/v1/slos?metric=${encodeURIComponent(metric)}&threshold=${encodeURIComponent(threshold)}&operator=${encodeURIComponent(operator)}&window_hours=${encodeURIComponent(windowHours)}&agent_name=${encodeURIComponent(agentName)}`;
      await apiRequest(path, "POST");
      setMessage("SLO created.");
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to create SLO");
    }
  };

  const deleteSlo = async (sloId: string) => {
    if (!window.confirm(`Delete SLO ${sloId}?`)) {
      return;
    }
    try {
      await apiRequest(`/api/v1/slos/${encodeURIComponent(sloId)}`, "DELETE");
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to delete SLO");
    }
  };

  const runCompare = async () => {
    try {
      const payload = await apiRequest<Record<string, unknown>>("/api/v1/compare", "POST", {
        agent_name: compareAgent,
        version_a: versionA,
        version_b: versionB,
      });
      setCompareResult(JSON.stringify(payload, null, 2));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Compare run failed");
    }
  };

  return (
    <div>
      <PageHeader title="Reliability (SLO + Compare)" subtitle="Define reliability targets and run A/B comparisons" />
      <Card className="mb-6">
        <div className="grid gap-2 md:grid-cols-6">
          <TextInput value={metric} onChange={(event) => setMetric(event.target.value)} placeholder="success_rate" />
          <TextInput value={threshold} onChange={(event) => setThreshold(event.target.value)} placeholder="0.95" />
          <TextInput value={operator} onChange={(event) => setOperator(event.target.value)} placeholder="gte" />
          <TextInput value={windowHours} onChange={(event) => setWindowHours(event.target.value)} placeholder="24" />
          <TextInput value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="optional agent name" />
          <Button onClick={() => void createSlo()}>Create SLO</Button>
        </div>
        {message ? <Text className="mt-2">{message}</Text> : null}
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <Text className="font-semibold mb-3">SLO Definitions</Text>
          <QueryState loading={slosQuery.loading} error={slosQuery.error} isEmpty={(slosQuery.data?.slos ?? []).length === 0}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Metric</TableHeaderCell>
                  <TableHeaderCell>Target</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell></TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(statusQuery.data?.slos ?? []).map((slo) => (
                  <TableRow key={slo.slo_id}>
                    <TableCell><Text>{slo.metric}</Text></TableCell>
                    <TableCell><Text>{slo.operator} {slo.threshold}</Text></TableCell>
                    <TableCell><Text>{slo.breached ? "Breached" : "Healthy"}</Text></TableCell>
                    <TableCell>
                      {slo.slo_id ? (
                        <Button size="xs" color="red" onClick={() => void deleteSlo(slo.slo_id ?? "")}>Delete</Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </QueryState>
        </Card>
        <Card>
          <Text className="font-semibold mb-3">A/B Compare</Text>
          <div className="grid gap-2 md:grid-cols-4">
            <TextInput value={compareAgent} onChange={(event) => setCompareAgent(event.target.value)} placeholder="agent name" />
            <TextInput value={versionA} onChange={(event) => setVersionA(event.target.value)} placeholder="version A" />
            <TextInput value={versionB} onChange={(event) => setVersionB(event.target.value)} placeholder="version B" />
            <Button onClick={() => void runCompare()}>Run Compare</Button>
          </div>
          {compareResult ? (
            <pre className="mt-3 max-h-72 overflow-auto rounded bg-gray-50 p-3 text-xs">{compareResult}</pre>
          ) : null}
        </Card>
      </div>
    </div>
  );
};
