import { useState, useMemo } from "react";
import {
  Network,
  Search,
  Globe,
  Link2,
  ExternalLink,
  Loader2,
  Filter,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { EmptyState } from "../../components/common/EmptyState";

/* ── Types ──────────────────────────────────────────────────────── */

type AgentStatus = "online" | "degraded" | "offline";

interface ExternalAgent {
  id: string;
  name: string;
  provider: string;
  capabilities: string[];
  endpoint: string;
  status: AgentStatus;
  description: string;
  lastSeen: string;
}

/* ── Mock data ──────────────────────────────────────────────────── */

const MOCK_AGENTS: ExternalAgent[] = [
  {
    id: "a2a_001",
    name: "ResearchBot",
    provider: "Acme AI",
    capabilities: ["web-search", "summarization", "citation"],
    endpoint: "https://api.acme.ai/a2a/research",
    status: "online",
    description: "Deep web research and academic paper summarization agent",
    lastSeen: "2026-03-26T10:30:00Z",
  },
  {
    id: "a2a_002",
    name: "DataTransformer",
    provider: "DataCorp",
    capabilities: ["etl", "data-cleaning", "schema-mapping"],
    endpoint: "https://agents.datacorp.io/transform",
    status: "online",
    description: "Enterprise data transformation and ETL pipeline agent",
    lastSeen: "2026-03-26T10:28:00Z",
  },
  {
    id: "a2a_003",
    name: "CodeReviewer",
    provider: "DevTools Inc",
    capabilities: ["code-review", "security-scan", "linting"],
    endpoint: "https://devtools.inc/a2a/review",
    status: "degraded",
    description: "Automated code review with security vulnerability detection",
    lastSeen: "2026-03-26T09:45:00Z",
  },
  {
    id: "a2a_004",
    name: "TranslationHub",
    provider: "LinguaAI",
    capabilities: ["translation", "localization", "sentiment"],
    endpoint: "https://lingua.ai/agent/translate",
    status: "online",
    description: "Multi-language translation and content localization",
    lastSeen: "2026-03-26T10:29:00Z",
  },
  {
    id: "a2a_005",
    name: "ComplianceChecker",
    provider: "RegTech Co",
    capabilities: ["compliance", "audit", "regulation-check"],
    endpoint: "https://regtech.co/a2a/compliance",
    status: "offline",
    description: "Regulatory compliance checking for financial documents",
    lastSeen: "2026-03-25T18:00:00Z",
  },
  {
    id: "a2a_006",
    name: "ImageAnalyzer",
    provider: "VisionLabs",
    capabilities: ["image-recognition", "ocr", "classification"],
    endpoint: "https://vision.labs/a2a/analyze",
    status: "online",
    description: "Image analysis, OCR extraction, and visual classification",
    lastSeen: "2026-03-26T10:31:00Z",
  },
];

const ALL_CAPABILITIES = Array.from(
  new Set(MOCK_AGENTS.flatMap((a) => a.capabilities)),
).sort();

/* ── Status helpers ─────────────────────────────────────────────── */

const statusDotColors: Record<AgentStatus, string> = {
  online: "bg-status-live",
  degraded: "bg-status-warning",
  offline: "bg-text-muted",
};

const statusLabels: Record<AgentStatus, string> = {
  online: "Online",
  degraded: "Degraded",
  offline: "Offline",
};

/* ── Component ──────────────────────────────────────────────────── */

export function A2ADiscoveryPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCapability, setSelectedCapability] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let list = MOCK_AGENTS;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.provider.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.capabilities.some((c) => c.toLowerCase().includes(q)),
      );
    }

    if (selectedCapability) {
      list = list.filter((a) => a.capabilities.includes(selectedCapability));
    }

    return list;
  }, [searchQuery, selectedCapability]);

  const handleConnect = async (agentId: string) => {
    setConnectingId(agentId);
    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 1500));
    setConnectingId(null);
  };

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="A2A Discovery"
        subtitle="Discover and connect to external agents via the Agent-to-Agent protocol"
        icon={<Network size={20} />}
      />

      {/* Search */}
      <div className="mb-[var(--space-4)]">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search agents by name, provider, or capability..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-surface-overlay min-h-[var(--touch-target-min)]"
          />
        </div>
      </div>

      {/* Capability filters */}
      <div className="flex flex-wrap items-center gap-[var(--space-2)] mb-[var(--space-6)]">
        <Filter size={14} className="text-text-muted" />
        <button
          onClick={() => setSelectedCapability(null)}
          className={`filter-chip min-h-[var(--touch-target-min)] ${
            selectedCapability === null ? "filter-chip-active" : ""
          }`}
        >
          All
        </button>
        {ALL_CAPABILITIES.map((cap) => (
          <button
            key={cap}
            onClick={() =>
              setSelectedCapability(selectedCapability === cap ? null : cap)
            }
            className={`filter-chip min-h-[var(--touch-target-min)] ${
              selectedCapability === cap ? "filter-chip-active" : ""
            }`}
          >
            {cap}
          </button>
        ))}
      </div>

      {/* Agent grid */}
      {filtered.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-[var(--space-4)]">
          {filtered.map((agent) => (
            <div
              key={agent.id}
              className="card card-lift glass-light relative overflow-hidden flex flex-col"
            >
              {/* Header row */}
              <div className="flex items-start gap-[var(--space-3)] mb-[var(--space-3)]">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-node-glow-blue text-chart-blue flex-shrink-0">
                  <Globe size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[var(--space-2)]">
                    <h3 className="text-[var(--text-sm)] font-semibold text-text-primary truncate">
                      {agent.name}
                    </h3>
                    {/* Status indicator dot */}
                    <span
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDotColors[agent.status]}`}
                      title={statusLabels[agent.status]}
                      aria-label={`Status: ${statusLabels[agent.status]}`}
                    />
                  </div>
                  <p className="text-[10px] text-text-muted uppercase tracking-wide">
                    {agent.provider}
                  </p>
                </div>
              </div>

              {/* Description */}
              <p className="text-[var(--text-xs)] text-text-secondary leading-relaxed mb-[var(--space-3)] line-clamp-2">
                {agent.description}
              </p>

              {/* Capabilities */}
              <div className="flex flex-wrap gap-[var(--space-1)] mb-[var(--space-3)]">
                {agent.capabilities.map((cap) => (
                  <span
                    key={cap}
                    className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-surface-overlay text-text-secondary border border-border-default"
                  >
                    {cap}
                  </span>
                ))}
              </div>

              {/* Endpoint */}
              <div className="flex items-center gap-[var(--space-1)] mb-[var(--space-4)] overflow-hidden">
                <Link2 size={10} className="text-text-muted flex-shrink-0" />
                <span className="text-[10px] text-text-muted font-mono truncate">
                  {agent.endpoint}
                </span>
              </div>

              {/* Footer */}
              <div className="mt-auto flex items-center justify-between">
                <span
                  className={`inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide ${
                    agent.status === "online"
                      ? "text-status-live"
                      : agent.status === "degraded"
                        ? "text-status-warning"
                        : "text-text-muted"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${statusDotColors[agent.status]}`}
                  />
                  {statusLabels[agent.status]}
                </span>

                <button
                  onClick={() => handleConnect(agent.id)}
                  disabled={connectingId === agent.id}
                  className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                >
                  {connectingId === agent.id ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    <>
                      <ExternalLink size={12} />
                      Connect
                    </>
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Network size={28} />}
          title="No agents found"
          description={
            searchQuery
              ? `No agents match "${searchQuery}"`
              : "No agents available with the selected capability."
          }
        />
      )}
    </div>
  );
}

export { A2ADiscoveryPage as default };
