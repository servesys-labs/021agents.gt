import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, TextInput } from "@tremor/react";
import { useMemo, useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { apiRequest, useApiQuery } from "../../lib/api";

type SandboxListResponse = {
  sandboxes?: Array<{
    sandbox_id?: string;
    status?: string;
    template?: string;
  }>;
};

type TimelineEntry = {
  at: string;
  action: string;
  result: string;
};

export const SandboxPage = () => {
  const [template, setTemplate] = useState("base");
  const [sandboxId, setSandboxId] = useState("");
  const [command, setCommand] = useState("python --version");
  const [filePath, setFilePath] = useState("/");
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [output, setOutput] = useState<string>("");
  const [error, setError] = useState<string>("");

  const sandboxesQuery = useApiQuery<SandboxListResponse>("/api/v1/sandbox/list");
  const sandboxes = useMemo(() => sandboxesQuery.data?.sandboxes ?? [], [sandboxesQuery.data]);

  const appendTimeline = (action: string, result: string) => {
    setTimeline((previous) => [
      { at: new Date().toLocaleTimeString(), action, result },
      ...previous,
    ]);
  };

  const createSandbox = async () => {
    setError("");
    try {
      const response = await apiRequest<{ sandbox_id?: string; status?: string }>(
        `/api/v1/sandbox/create?template=${encodeURIComponent(template)}&timeout_sec=300`,
        "POST",
      );
      if (response.sandbox_id) {
        setSandboxId(response.sandbox_id);
      }
      appendTimeline("create", response.status ?? "created");
      await sandboxesQuery.refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Create failed";
      setError(message);
      appendTimeline("create", `error: ${message}`);
    }
  };

  const executeCommand = async () => {
    if (!sandboxId) {
      setError("Set a sandbox_id first.");
      return;
    }
    setError("");
    try {
      const response = await apiRequest<{ stdout?: string; stderr?: string; exit_code?: number }>(
        `/api/v1/sandbox/exec?command=${encodeURIComponent(command)}&sandbox_id=${encodeURIComponent(sandboxId)}&timeout_ms=30000`,
        "POST",
      );
      const nextOutput = [response.stdout, response.stderr].filter(Boolean).join("\n");
      setOutput(nextOutput || "(no output)");
      appendTimeline("exec", `exit=${response.exit_code ?? "?"}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Exec failed";
      setError(message);
      appendTimeline("exec", `error: ${message}`);
    }
  };

  const listFiles = async () => {
    if (!sandboxId) {
      setError("Set a sandbox_id first.");
      return;
    }
    setError("");
    try {
      const response = await apiRequest<{ files?: string[] }>(
        `/api/v1/sandbox/${encodeURIComponent(sandboxId)}/files?path=${encodeURIComponent(filePath)}`,
      );
      setOutput((response.files ?? []).join("\n"));
      appendTimeline("files.list", `${response.files?.length ?? 0} entries`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "List files failed";
      setError(message);
      appendTimeline("files.list", `error: ${message}`);
    }
  };

  return (
    <div>
      <PageHeader title="Sandbox Studio" subtitle="Create, execute, inspect, and manage sandboxes" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <Text className="font-semibold mb-3">Actions</Text>
          <div className="space-y-3">
            <div>
              <Text>Template</Text>
              <TextInput value={template} onChange={(event) => setTemplate(event.target.value)} />
            </div>
            <Button onClick={() => void createSandbox()}>Create Sandbox</Button>

            <div>
              <Text>Sandbox ID</Text>
              <TextInput value={sandboxId} onChange={(event) => setSandboxId(event.target.value)} placeholder="sbx_..." />
            </div>
            <div>
              <Text>Command</Text>
              <TextInput value={command} onChange={(event) => setCommand(event.target.value)} />
            </div>
            <Button onClick={() => void executeCommand()}>Run Command</Button>

            <div>
              <Text>File path</Text>
              <TextInput value={filePath} onChange={(event) => setFilePath(event.target.value)} />
            </div>
            <Button onClick={() => void listFiles()}>List Files</Button>
          </div>
          {error ? <Text className="mt-3 text-red-600">{error}</Text> : null}
        </Card>

        <Card>
          <Text className="font-semibold mb-3">Operation Timeline</Text>
          {timeline.length === 0 ? (
            <Text className="text-gray-500">No operations yet.</Text>
          ) : (
            <div className="space-y-2">
              {timeline.map((entry, index) => (
                <div key={`${entry.at}-${entry.action}-${index}`} className="rounded border p-2">
                  <Text className="font-medium">{entry.action}</Text>
                  <Text className="text-xs text-gray-500">{entry.at}</Text>
                  <Text>{entry.result}</Text>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="mt-6">
        <Text className="font-semibold mb-2">Output</Text>
        <pre className="max-h-72 overflow-auto rounded bg-gray-50 p-3 text-xs">{output || "(no output yet)"}</pre>
      </Card>

      <div className="mt-6">
        <QueryState
          loading={sandboxesQuery.loading}
          error={sandboxesQuery.error}
          isEmpty={sandboxes.length === 0}
          emptyMessage="No active sandboxes."
          onRetry={() => void sandboxesQuery.refetch()}
        >
          <Card>
            <Text className="font-semibold mb-3">Active Sandboxes</Text>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>ID</TableHeaderCell>
                  <TableHeaderCell>Template</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sandboxes.map((entry) => (
                  <TableRow key={entry.sandbox_id}>
                    <TableCell><Text className="font-mono text-xs">{entry.sandbox_id}</Text></TableCell>
                    <TableCell><Text>{entry.template ?? "base"}</Text></TableCell>
                    <TableCell><Badge>{entry.status ?? "unknown"}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </QueryState>
      </div>
    </div>
  );
};
