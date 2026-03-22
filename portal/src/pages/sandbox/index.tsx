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
        <div className="card">
          <p className="font-semibold text-white mb-3">Actions</p>
          <div className="space-y-3">
            <div>
              <span className="text-gray-400">Template</span>
              <input className="input-field" value={template} onChange={(event) => setTemplate(event.target.value)} />
            </div>
            <button className="btn-primary" onClick={() => void createSandbox()}>Create Sandbox</button>

            <div>
              <span className="text-gray-400">Sandbox ID</span>
              <input className="input-field" value={sandboxId} onChange={(event) => setSandboxId(event.target.value)} placeholder="sbx_..." />
            </div>
            <div>
              <span className="text-gray-400">Command</span>
              <input className="input-field" value={command} onChange={(event) => setCommand(event.target.value)} />
            </div>
            <button className="btn-primary" onClick={() => void executeCommand()}>Run Command</button>

            <div>
              <span className="text-gray-400">File path</span>
              <input className="input-field" value={filePath} onChange={(event) => setFilePath(event.target.value)} />
            </div>
            <button className="btn-primary" onClick={() => void listFiles()}>List Files</button>
          </div>
          {error ? <span className="mt-3 text-red-600">{error}</span> : null}
        </div>

        <div className="card">
          <p className="font-semibold text-white mb-3">Operation Timeline</p>
          {timeline.length === 0 ? (
            <span className="text-gray-500">No operations yet.</span>
          ) : (
            <div className="space-y-2">
              {timeline.map((entry, index) => (
                <div key={`${entry.at}-${entry.action}-${index}`} className="rounded border border-[#2a2a2a] p-2">
                  <span className="font-medium text-white">{entry.action}</span>
                  <span className="text-xs text-gray-500">{entry.at}</span>
                  <span className="text-gray-400">{entry.result}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card mt-6">
        <p className="font-semibold text-white mb-2">Output</p>
        <pre className="max-h-72 overflow-auto rounded bg-[#111] border border-[#2a2a2a] p-3 text-xs">{output || "(no output yet)"}</pre>
      </div>

      <div className="mt-6">
        <QueryState
          loading={sandboxesQuery.loading}
          error={sandboxesQuery.error}
          isEmpty={sandboxes.length === 0}
          emptyMessage="No active sandboxes."
          onRetry={() => void sandboxesQuery.refetch()}
        >
          <div className="card">
            <p className="font-semibold text-white mb-3">Active Sandboxes</p>
            <table className="os-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Template</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sandboxes.map((entry) => (
                  <tr key={entry.sandbox_id}>
                    <td><span className="font-mono text-xs text-gray-300">{entry.sandbox_id}</span></td>
                    <td><span className="text-gray-400">{entry.template ?? "base"}</span></td>
                    <td><span className="badge">{entry.status ?? "unknown"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryState>
      </div>
    </div>
  );
};
