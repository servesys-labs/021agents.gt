import { useMemo, useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { summarizeCoverage } from "../../lib/adapters";
import { useApiQuery } from "../../lib/api";

type OpenApiDocument = {
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, { tags?: string[]; summary?: string }>>;
};

type EndpointRow = {
  method: string;
  path: string;
  tags: string;
  summary: string;
  surface: "v1" | "legacy";
};

export const ApiExplorerPage = () => {
  const [query, setQuery] = useState("");
  const openApiQuery = useApiQuery<OpenApiDocument>("/openapi.json");

  const endpoints = useMemo<EndpointRow[]>(() => {
    const rows: EndpointRow[] = [];
    const pathMap = openApiQuery.data?.paths ?? {};
    for (const [path, operations] of Object.entries(pathMap)) {
      for (const [method, operation] of Object.entries(operations)) {
        rows.push({
          method: method.toUpperCase(),
          path,
          tags: (operation.tags ?? []).join(", "),
          summary: operation.summary ?? "",
          surface: path.startsWith("/api/v1/") ? "v1" : "legacy",
        });
      }
    }
    return rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  }, [openApiQuery.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return endpoints;
    }
    return endpoints.filter((endpoint) => {
      return (
        endpoint.path.toLowerCase().includes(q) ||
        endpoint.method.toLowerCase().includes(q) ||
        endpoint.tags.toLowerCase().includes(q) ||
        endpoint.summary.toLowerCase().includes(q)
      );
    });
  }, [endpoints, query]);

  const coverage = summarizeCoverage(endpoints.map((endpoint) => endpoint.path));

  return (
    <div>
      <PageHeader
        title="API Explorer"
        subtitle="OpenAPI-powered endpoint inventory for full control-plane surface"
      />

      <div className="grid gap-4 md:grid-cols-4 mb-6">
        <div className="card">
          <span className="text-gray-400">Total Endpoints</span>
          <p className="text-3xl font-bold text-white">{coverage.total}</p>
        </div>
        <div className="card">
          <span className="text-gray-400">v1 Endpoints</span>
          <p className="text-3xl font-bold text-white">{coverage.v1}</p>
        </div>
        <div className="card">
          <span className="text-gray-400">Legacy Endpoints</span>
          <p className="text-3xl font-bold text-white">{coverage.legacy}</p>
        </div>
        <div className="card">
          <span className="text-gray-400">Document</span>
          <span className="text-gray-400">{openApiQuery.data?.info?.title ?? "AgentOS"} {openApiQuery.data?.info?.version ?? ""}</span>
        </div>
      </div>

      <div className="card mb-4">
        <input className="input-field" value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by path, method, tag, or summary"
        />
      </div>

      <QueryState
        loading={openApiQuery.loading}
        error={openApiQuery.error}
        isEmpty={filtered.length === 0}
        emptyMessage="No endpoints match this filter."
        onRetry={() => void openApiQuery.refetch()}
      >
        <div className="card">
          <table className="os-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Surface</th>
                <th>Tags</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((endpoint) => (
                <tr key={`${endpoint.method}-${endpoint.path}`}>
                  <td><span className="badge">{endpoint.method}</span></td>
                  <td><span className="font-mono text-xs text-gray-300">{endpoint.path}</span></td>
                  <td>
                    <span className="badge">{endpoint.surface}</span>
                  </td>
                  <td><span className="text-gray-400">{endpoint.tags || "untagged"}</span></td>
                  <td><span className="text-gray-400">{endpoint.summary || "-"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
    </div>
  );
};
