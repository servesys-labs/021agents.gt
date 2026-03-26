import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus,
  Search,
  Wrench,
  Filter,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import { StatusBadge } from "../../components/common/StatusBadge";
import { useApiQuery } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

export type Tool = {
  name: string;
  description?: string;
  type?: string;
  category?: string;
  status?: string;
  version?: string;
  schema?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

/* ── Tools Page ─────────────────────────────────────────────────── */

export function ToolsPage() {
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const { data, loading, error, refetch } = useApiQuery<Tool[]>("/api/v1/tools");

  const tools = useMemo(() => data ?? [], [data]);

  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const tool of tools) {
      if (tool.category) cats.add(tool.category);
    }
    return Array.from(cats).sort();
  }, [tools]);

  const filtered = useMemo(() => {
    let result = tools;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description?.toLowerCase().includes(q),
      );
    }
    if (categoryFilter !== "all") {
      result = result.filter((t) => t.category === categoryFilter);
    }
    return result;
  }, [tools, search, categoryFilter]);

  return (
    <div>
      <PageHeader
        title="Tools"
        subtitle={`${tools.length} registered tools`}
        onRefresh={() => void refetch()}
        actions={
          <button
            className="btn btn-primary text-xs"
            onClick={() => navigate("/tools/create")}
          >
            <Plus size={14} />
            Register Tool
          </button>
        }
      />

      {/* Search & Filter bar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            placeholder="Search tools..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 text-xs"
          />
        </div>
        {categories.length > 0 && (
          <div className="flex items-center gap-2">
            <Filter size={14} className="text-text-muted" />
            <select
              className="text-xs w-auto"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="all">All Categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Tool list */}
      <QueryState
        loading={loading}
        error={error}
        isEmpty={tools.length === 0}
        emptyMessage=""
        onRetry={() => void refetch()}
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Wrench size={40} />}
            title="No tools found"
            description={
              search || categoryFilter !== "all"
                ? "Try a different search term or filter"
                : "Register your first tool to get started"
            }
            action={
              !search && categoryFilter === "all" ? (
                <button
                  className="btn btn-primary text-xs"
                  onClick={() => navigate("/tools/create")}
                >
                  <Plus size={14} />
                  Register Tool
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="card p-0">
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Description</th>
                    <th>Type</th>
                    <th>Category</th>
                    <th>Status</th>
                    <th>Version</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((tool) => (
                    <tr
                      key={tool.name}
                      className="cursor-pointer hover:bg-surface-overlay/50"
                      onClick={() => navigate(`/tools/${encodeURIComponent(tool.name)}`)}
                    >
                      <td className="font-medium text-text-primary">
                        {tool.name}
                      </td>
                      <td className="text-text-muted max-w-xs truncate">
                        {tool.description || "--"}
                      </td>
                      <td>
                        <span className="px-2 py-0.5 text-[10px] font-mono bg-surface-overlay text-text-secondary rounded border border-border-default">
                          {tool.type || "function"}
                        </span>
                      </td>
                      <td className="text-text-muted text-xs">
                        {tool.category || "--"}
                      </td>
                      <td>
                        <StatusBadge status={tool.status || "active"} />
                      </td>
                      <td className="text-[10px] text-text-muted font-mono">
                        {tool.version || "--"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </QueryState>
    </div>
  );
}

export { ToolsPage as default };
