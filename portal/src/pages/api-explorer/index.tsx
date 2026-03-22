import { Badge, Card, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, TextInput } from "@tremor/react";
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
        <Card>
          <Text>Total Endpoints</Text>
          <Text className="text-3xl font-bold">{coverage.total}</Text>
        </Card>
        <Card>
          <Text>v1 Endpoints</Text>
          <Text className="text-3xl font-bold">{coverage.v1}</Text>
        </Card>
        <Card>
          <Text>Legacy Endpoints</Text>
          <Text className="text-3xl font-bold">{coverage.legacy}</Text>
        </Card>
        <Card>
          <Text>Document</Text>
          <Text>{openApiQuery.data?.info?.title ?? "AgentOS"} {openApiQuery.data?.info?.version ?? ""}</Text>
        </Card>
      </div>

      <Card className="mb-4">
        <TextInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by path, method, tag, or summary"
        />
      </Card>

      <QueryState
        loading={openApiQuery.loading}
        error={openApiQuery.error}
        isEmpty={filtered.length === 0}
        emptyMessage="No endpoints match this filter."
        onRetry={() => void openApiQuery.refetch()}
      >
        <Card>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Method</TableHeaderCell>
                <TableHeaderCell>Path</TableHeaderCell>
                <TableHeaderCell>Surface</TableHeaderCell>
                <TableHeaderCell>Tags</TableHeaderCell>
                <TableHeaderCell>Summary</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((endpoint) => (
                <TableRow key={`${endpoint.method}-${endpoint.path}`}>
                  <TableCell><Badge>{endpoint.method}</Badge></TableCell>
                  <TableCell><Text className="font-mono text-xs">{endpoint.path}</Text></TableCell>
                  <TableCell>
                    <Badge color={endpoint.surface === "v1" ? "blue" : "amber"}>{endpoint.surface}</Badge>
                  </TableCell>
                  <TableCell><Text>{endpoint.tags || "untagged"}</Text></TableCell>
                  <TableCell><Text>{endpoint.summary || "-"}</Text></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </QueryState>
    </div>
  );
};
