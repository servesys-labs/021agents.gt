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
      <div className="card mb-6">
        <div className="grid gap-2 md:grid-cols-3">
          <select className="input-field" value={selectedAgent} onChange={(e) => setAgentName(e.target.value)}>
            {agents.map((agent) => (
              <option key={agent.name} value={agent.name}>{agent.name}</option>
            ))}
          </select>
          <input className="input-field" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search query" />
          <button className="btn-secondary" onClick={() => void refresh()}>Search</button>
        </div>
        {actionError ? <span className="mt-2 text-red-600">{actionError}</span> : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card">
          <p className="font-semibold text-white mb-3">Episodes</p>
          <div className="space-y-2 mb-3">
            <input className="input-field" value={episodeInput} onChange={(event) => setEpisodeInput(event.target.value)} placeholder="Input text" />
            <input className="input-field" value={episodeOutput} onChange={(event) => setEpisodeOutput(event.target.value)} placeholder="Output text" />
            <button className="btn-primary text-xs" onClick={() => void createEpisode()}>Add Episode</button>
            <button className="btn-danger text-xs" onClick={() => void clearSection(`/api/v1/memory/${encodeURIComponent(selectedAgent)}/episodes`)}>
              Clear Episodes
            </button>
          </div>
          <QueryState loading={episodesQuery.loading} error={episodesQuery.error} isEmpty={(episodesQuery.data?.episodes ?? []).length === 0}>
            <table className="os-table">
              <thead><tr><th>Preview</th></tr></thead>
              <tbody>
                {(episodesQuery.data?.episodes ?? []).map((episode, index) => (
                  <tr key={`${episode.id}-${index}`}>
                    <td><span className="text-gray-400">{(episode.input || "").slice(0, 60)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>
        <div className="card">
          <p className="font-semibold text-white mb-3">Facts</p>
          <div className="space-y-2 mb-3">
            <input className="input-field" value={factKey} onChange={(event) => setFactKey(event.target.value)} placeholder="fact key" />
            <input className="input-field" value={factValue} onChange={(event) => setFactValue(event.target.value)} placeholder="fact value" />
            <button className="btn-primary text-xs" onClick={() => void upsertFact()}>Upsert Fact</button>
            <button className="btn-danger text-xs" onClick={() => void clearSection(`/api/v1/memory/${encodeURIComponent(selectedAgent)}/facts`)}>
              Clear Facts
            </button>
          </div>
          <QueryState loading={factsQuery.loading} error={factsQuery.error} isEmpty={(factsQuery.data?.facts ?? []).length === 0}>
            <table className="os-table">
              <thead><tr><th>Key</th></tr></thead>
              <tbody>
                {(factsQuery.data?.facts ?? []).map((fact, index) => (
                  <tr key={`${fact.key}-${index}`}>
                    <td><span className="text-gray-400">{fact.key}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>
        <div className="card">
          <p className="font-semibold text-white mb-3">Procedures</p>
          <button className="btn-danger text-xs mb-3" onClick={() => void clearSection(`/api/v1/memory/${encodeURIComponent(selectedAgent)}/procedures`)}>
            Clear Procedures
          </button>
          <QueryState loading={proceduresQuery.loading} error={proceduresQuery.error} isEmpty={(proceduresQuery.data?.procedures ?? []).length === 0}>
            <table className="os-table">
              <thead><tr><th>Name</th><th>Success</th></tr></thead>
              <tbody>
                {(proceduresQuery.data?.procedures ?? []).map((proc, index) => (
                  <tr key={`${proc.procedure_id}-${index}`}>
                    <td><span className="text-gray-400">{proc.name || proc.procedure_id}</span></td>
                    <td><span className="text-gray-400">{((proc.success_rate ?? 0) * 100).toFixed(1)}%</span></td>
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
