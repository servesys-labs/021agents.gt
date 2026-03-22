import { useMemo, useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import type { AgentInfo } from "../../lib/adapters";
import { useApiQuery } from "../../lib/api";

type RagStatus = { indexed?: boolean; documents?: number; chunks?: number; sources?: string[] };
type RagDocument = { metadata?: { source?: string }; length?: number };

export const RagPage = () => {
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents");
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const [agentName, setAgentName] = useState("");
  const selectedAgent = agentName || agents[0]?.name || "";
  const [chunkSize, setChunkSize] = useState("512");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const statusQuery = useApiQuery<RagStatus>(
    `/api/v1/rag/${encodeURIComponent(selectedAgent)}/status`,
    Boolean(selectedAgent),
  );
  const docsQuery = useApiQuery<{ documents: RagDocument[] }>(
    `/api/v1/rag/${encodeURIComponent(selectedAgent)}/documents`,
    Boolean(selectedAgent),
  );

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    setError("");
    setMessage("");
    try {
      const formData = new FormData();
      for (const file of Array.from(files)) {
        formData.append("files", file);
      }
      formData.append("chunk_size", chunkSize);
      const token = localStorage.getItem("token");
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetch(`/api/v1/rag/${encodeURIComponent(selectedAgent)}/ingest`, {
        method: "POST",
        headers,
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`Ingest failed (${response.status})`);
      }
      setMessage("Documents ingested successfully.");
      await statusQuery.refetch();
      await docsQuery.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "RAG ingest failed");
    }
  };

  return (
    <div>
      <PageHeader title="RAG & Ingest" subtitle="Upload documents and monitor retrieval index state" />
      <div className="card mb-6">
        <div className="grid gap-2 md:grid-cols-3">
          <select className="input-field" value={selectedAgent} onChange={(e) => setAgentName(e.target.value)}>
            {agents.map((agent) => (
              <option key={agent.name} value={agent.name}>{agent.name}</option>
            ))}
          </select>
          <input className="input-field" value={chunkSize} onChange={(event) => setChunkSize(event.target.value)} placeholder="chunk size" />
          <input
            type="file"
            multiple
            className="text-sm"
            onChange={(event) => void upload(event.target.files)}
          />
        </div>
        {message ? <span className="mt-2 text-emerald-600">{message}</span> : null}
        {error ? <span className="mt-2 text-red-600">{error}</span> : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card">
          <p className="font-semibold text-white mb-3">Index Status</p>
          <QueryState loading={statusQuery.loading} error={statusQuery.error} isEmpty={!statusQuery.data}>
            <pre className="max-h-72 overflow-auto rounded bg-[#111] border border-[#2a2a2a] p-3 text-xs">
              {JSON.stringify(statusQuery.data, null, 2)}
            </pre>
          </QueryState>
        </div>
        <div className="card">
          <p className="font-semibold text-white mb-3">Indexed Documents</p>
          <QueryState
            loading={docsQuery.loading}
            error={docsQuery.error}
            isEmpty={(docsQuery.data?.documents ?? []).length === 0}
            emptyMessage="No ingested documents."
          >
            <table className="os-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Length</th>
                </tr>
              </thead>
              <tbody>
                {(docsQuery.data?.documents ?? []).map((doc, index) => (
                  <tr key={`${doc.metadata?.source}-${index}`}>
                    <td><span className="text-gray-400">{doc.metadata?.source ?? `document-${index + 1}`}</span></td>
                    <td><span className="text-gray-400">{doc.length ?? 0}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>
      </div>
    </div>
  );
};
