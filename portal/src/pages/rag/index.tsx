import { Card, Select, SelectItem, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, TextInput } from "@tremor/react";
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
      <Card className="mb-6">
        <div className="grid gap-2 md:grid-cols-3">
          <Select value={selectedAgent} onValueChange={setAgentName}>
            {agents.map((agent) => (
              <SelectItem key={agent.name} value={agent.name}>{agent.name}</SelectItem>
            ))}
          </Select>
          <TextInput value={chunkSize} onChange={(event) => setChunkSize(event.target.value)} placeholder="chunk size" />
          <input
            type="file"
            multiple
            className="text-sm"
            onChange={(event) => void upload(event.target.files)}
          />
        </div>
        {message ? <Text className="mt-2 text-emerald-600">{message}</Text> : null}
        {error ? <Text className="mt-2 text-red-600">{error}</Text> : null}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <Text className="font-semibold mb-3">Index Status</Text>
          <QueryState loading={statusQuery.loading} error={statusQuery.error} isEmpty={!statusQuery.data}>
            <pre className="max-h-72 overflow-auto rounded bg-gray-50 p-3 text-xs">
              {JSON.stringify(statusQuery.data, null, 2)}
            </pre>
          </QueryState>
        </Card>
        <Card>
          <Text className="font-semibold mb-3">Indexed Documents</Text>
          <QueryState
            loading={docsQuery.loading}
            error={docsQuery.error}
            isEmpty={(docsQuery.data?.documents ?? []).length === 0}
            emptyMessage="No ingested documents."
          >
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Source</TableHeaderCell>
                  <TableHeaderCell>Length</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(docsQuery.data?.documents ?? []).map((doc, index) => (
                  <TableRow key={`${doc.metadata?.source}-${index}`}>
                    <TableCell><Text>{doc.metadata?.source ?? `document-${index + 1}`}</Text></TableCell>
                    <TableCell><Text>{doc.length ?? 0}</Text></TableCell>
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
