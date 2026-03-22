import { Button, Card, Select, SelectItem, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, TextInput } from "@tremor/react";
import { useMemo, useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import type { AgentInfo } from "../../lib/adapters";
import { apiRequest, useApiQuery } from "../../lib/api";

type Episode = { id?: string; input?: string; output?: string; outcome?: string };
type Fact = { key?: string; value?: unknown };
type Procedure = { procedure_id?: string; name?: string; success_rate?: number };

export const MemoryPage = () => {
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents");
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const [agentName, setAgentName] = useState("");
  const selectedAgent = agentName || agents[0]?.name || "";
  const [query, setQuery] = useState("");
  const [factKey, setFactKey] = useState("");
  const [factValue, setFactValue] = useState("");
  const [episodeInput, setEpisodeInput] = useState("");
  const [episodeOutput, setEpisodeOutput] = useState("");
  const [actionError, setActionError] = useState("");

  const episodesQuery = useApiQuery<{ episodes: Episode[] }>(
    `/api/v1/memory/${encodeURIComponent(selectedAgent)}/episodes?query=${encodeURIComponent(query)}&limit=100`,
    Boolean(selectedAgent),
  );
  const factsQuery = useApiQuery<{ facts: Fact[] }>(
    `/api/v1/memory/${encodeURIComponent(selectedAgent)}/facts?query=${encodeURIComponent(query)}&limit=100`,
    Boolean(selectedAgent),
  );
  const proceduresQuery = useApiQuery<{ procedures: Procedure[] }>(
    `/api/v1/memory/${encodeURIComponent(selectedAgent)}/procedures?limit=100`,
    Boolean(selectedAgent),
  );

  const refresh = async () => {
    await episodesQuery.refetch();
    await factsQuery.refetch();
    await proceduresQuery.refetch();
  };

  const createEpisode = async () => {
    try {
      await apiRequest(
        `/api/v1/memory/${encodeURIComponent(selectedAgent)}/episodes?input_text=${encodeURIComponent(episodeInput)}&output_text=${encodeURIComponent(episodeOutput)}`,
        "POST",
      );
      setEpisodeInput("");
      setEpisodeOutput("");
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to create episode");
    }
  };

  const upsertFact = async () => {
    try {
      await apiRequest(
        `/api/v1/memory/${encodeURIComponent(selectedAgent)}/facts?key=${encodeURIComponent(factKey)}&value=${encodeURIComponent(factValue)}`,
        "POST",
      );
      setFactKey("");
      setFactValue("");
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to upsert fact");
    }
  };

  const clearSection = async (path: string) => {
    if (!window.confirm("This will clear data. Continue?")) {
      return;
    }
    try {
      await apiRequest(path, "DELETE");
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to clear memory");
    }
  };

  return (
    <div>
      <PageHeader title="Memory Management" subtitle="Episodes, facts, and procedures" />
      <Card className="mb-6">
        <div className="grid gap-2 md:grid-cols-3">
          <Select value={selectedAgent} onValueChange={setAgentName}>
            {agents.map((agent) => (
              <SelectItem key={agent.name} value={agent.name}>{agent.name}</SelectItem>
            ))}
          </Select>
          <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search query" />
          <Button variant="secondary" onClick={() => void refresh()}>Search</Button>
        </div>
        {actionError ? <Text className="mt-2 text-red-600">{actionError}</Text> : null}
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <Text className="font-semibold mb-3">Episodes</Text>
          <div className="space-y-2 mb-3">
            <TextInput value={episodeInput} onChange={(event) => setEpisodeInput(event.target.value)} placeholder="Input text" />
            <TextInput value={episodeOutput} onChange={(event) => setEpisodeOutput(event.target.value)} placeholder="Output text" />
            <Button size="xs" onClick={() => void createEpisode()}>Add Episode</Button>
            <Button size="xs" color="red" variant="secondary" onClick={() => void clearSection(`/api/v1/memory/${encodeURIComponent(selectedAgent)}/episodes`)}>
              Clear Episodes
            </Button>
          </div>
          <QueryState loading={episodesQuery.loading} error={episodesQuery.error} isEmpty={(episodesQuery.data?.episodes ?? []).length === 0}>
            <Table>
              <TableHead><TableRow><TableHeaderCell>Preview</TableHeaderCell></TableRow></TableHead>
              <TableBody>
                {(episodesQuery.data?.episodes ?? []).map((episode, index) => (
                  <TableRow key={`${episode.id}-${index}`}>
                    <TableCell><Text>{(episode.input || "").slice(0, 60)}</Text></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </QueryState>
        </Card>
        <Card>
          <Text className="font-semibold mb-3">Facts</Text>
          <div className="space-y-2 mb-3">
            <TextInput value={factKey} onChange={(event) => setFactKey(event.target.value)} placeholder="fact key" />
            <TextInput value={factValue} onChange={(event) => setFactValue(event.target.value)} placeholder="fact value" />
            <Button size="xs" onClick={() => void upsertFact()}>Upsert Fact</Button>
            <Button size="xs" color="red" variant="secondary" onClick={() => void clearSection(`/api/v1/memory/${encodeURIComponent(selectedAgent)}/facts`)}>
              Clear Facts
            </Button>
          </div>
          <QueryState loading={factsQuery.loading} error={factsQuery.error} isEmpty={(factsQuery.data?.facts ?? []).length === 0}>
            <Table>
              <TableHead><TableRow><TableHeaderCell>Key</TableHeaderCell></TableRow></TableHead>
              <TableBody>
                {(factsQuery.data?.facts ?? []).map((fact, index) => (
                  <TableRow key={`${fact.key}-${index}`}>
                    <TableCell><Text>{fact.key}</Text></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </QueryState>
        </Card>
        <Card>
          <Text className="font-semibold mb-3">Procedures</Text>
          <Button size="xs" color="red" variant="secondary" className="mb-3" onClick={() => void clearSection(`/api/v1/memory/${encodeURIComponent(selectedAgent)}/procedures`)}>
            Clear Procedures
          </Button>
          <QueryState loading={proceduresQuery.loading} error={proceduresQuery.error} isEmpty={(proceduresQuery.data?.procedures ?? []).length === 0}>
            <Table>
              <TableHead><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Success</TableHeaderCell></TableRow></TableHead>
              <TableBody>
                {(proceduresQuery.data?.procedures ?? []).map((proc, index) => (
                  <TableRow key={`${proc.procedure_id}-${index}`}>
                    <TableCell><Text>{proc.name || proc.procedure_id}</Text></TableCell>
                    <TableCell><Text>{((proc.success_rate ?? 0) * 100).toFixed(1)}%</Text></TableCell>
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
