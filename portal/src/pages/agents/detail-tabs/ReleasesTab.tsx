import { useCallback, useMemo, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Loader2,
  Minus,
  Plus,
  Rocket,
  Trash2,
  X,
} from "lucide-react";

import { useApiQuery, apiPost, apiDelete } from "../../../lib/api";
import { useToast } from "../../../components/common/ToastProvider";
import { QueryState } from "../../../components/common/QueryState";
import { EmptyState } from "../../../components/common/EmptyState";

/* -- Types ----------------------------------------------------------- */

type ReleaseChannel = {
  channel: string;
  version?: string;
  config_hash?: string;
  promoted_by?: string;
  promoted_at?: string;
};

type CanaryStatus = {
  active: boolean;
  primary_version?: string;
  canary_version?: string;
  canary_weight?: number;
};

type VersionEntry = {
  version: string;
  created_by?: string;
  created_at?: string;
  config?: Record<string, unknown>;
};

/* -- Helpers --------------------------------------------------------- */

function formatDate(ts?: string | number): string {
  if (!ts) return "--";
  const d = new Date(typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function diffObjects(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): { key: string; old: string; new: string }[] {
  if (!a || !b) return [];
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs: { key: string; old: string; new: string }[] = [];
  allKeys.forEach((key) => {
    const av = JSON.stringify(a[key] ?? null);
    const bv = JSON.stringify(b[key] ?? null);
    if (av !== bv) {
      diffs.push({ key, old: av, new: bv });
    }
  });
  return diffs;
}

/* -- Component ------------------------------------------------------- */

export const ReleasesTab = ({ agentName }: { agentName: string }) => {
  const { showToast } = useToast();

  /* -- Section A: Release Channels ----------------------------------- */
  const channelsQuery = useApiQuery<{ channels: ReleaseChannel[] } | ReleaseChannel[]>(
    `/api/v1/releases/${agentName}/channels`,
    Boolean(agentName),
  );

  const channels: ReleaseChannel[] = useMemo(() => {
    const raw = channelsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.channels ?? [];
  }, [channelsQuery.data]);

  const [promoting, setPromoting] = useState<string | null>(null);

  const handlePromote = useCallback(
    async (from: string, to: string) => {
      setPromoting(`${from}->${to}`);
      try {
        await apiPost(`/api/v1/releases/${agentName}/promote`, {
          from_channel: from,
          to_channel: to,
        });
        showToast(`Promoted ${from} to ${to}`, "success");
        void channelsQuery.refetch();
      } catch {
        showToast(`Failed to promote ${from} to ${to}`, "error");
      } finally {
        setPromoting(null);
      }
    },
    [agentName, showToast, channelsQuery],
  );

  /* -- Section B: Canary Configuration ------------------------------- */
  const canaryQuery = useApiQuery<CanaryStatus>(
    `/api/v1/releases/${agentName}/canary`,
    Boolean(agentName),
  );

  const canary = canaryQuery.data;
  const canaryActive = canary?.active ?? false;

  const [canaryModalOpen, setCanaryModalOpen] = useState(false);
  const [canaryPrimary, setCanaryPrimary] = useState("");
  const [canaryVersion, setCanaryVersion] = useState("");
  const [canaryWeight, setCanaryWeight] = useState(10);
  const [canarySubmitting, setCanarySubmitting] = useState(false);

  const handleSetCanary = useCallback(async () => {
    setCanarySubmitting(true);
    try {
      await apiPost(`/api/v1/releases/${agentName}/canary`, {
        primary_version: canaryPrimary,
        canary_version: canaryVersion,
        canary_weight: canaryWeight,
      });
      showToast("Canary deployment configured", "success");
      setCanaryModalOpen(false);
      void canaryQuery.refetch();
    } catch {
      showToast("Failed to set up canary", "error");
    } finally {
      setCanarySubmitting(false);
    }
  }, [agentName, canaryPrimary, canaryVersion, canaryWeight, showToast, canaryQuery]);

  const handleUpdateCanaryWeight = useCallback(
    async (weight: number) => {
      try {
        await apiPost(`/api/v1/releases/${agentName}/canary`, {
          primary_version: canary?.primary_version,
          canary_version: canary?.canary_version,
          canary_weight: weight,
        });
        void canaryQuery.refetch();
      } catch {
        showToast("Failed to update canary weight", "error");
      }
    },
    [agentName, canary, showToast, canaryQuery],
  );

  const handleRemoveCanary = useCallback(async () => {
    try {
      await apiDelete(`/api/v1/releases/${agentName}/canary`);
      showToast("Canary removed", "success");
      void canaryQuery.refetch();
    } catch {
      showToast("Failed to remove canary", "error");
    }
  }, [agentName, showToast, canaryQuery]);

  /* -- Section C: Version History ------------------------------------ */
  const versionsQuery = useApiQuery<{ versions: VersionEntry[] } | VersionEntry[]>(
    `/api/v1/agents/${agentName}/versions`,
    Boolean(agentName),
  );

  const versions: VersionEntry[] = useMemo(() => {
    const raw = versionsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.versions ?? [];
  }, [versionsQuery.data]);

  const [diffRow, setDiffRow] = useState<string | null>(null);

  const getDiff = useCallback(
    (idx: number) => {
      const current = versions[idx];
      const prev = versions[idx + 1];
      if (!current?.config || !prev?.config) return [];
      return diffObjects(prev.config, current.config);
    },
    [versions],
  );

  /* -- Render -------------------------------------------------------- */

  return (
    <div className="space-y-[var(--space-8)]">
      {/* Section A: Release Channels */}
      <section>
        <h2 className="text-[var(--text-md)] font-semibold text-text-primary mb-[var(--space-4)]">
          Release Channels
        </h2>
        <QueryState
          loading={channelsQuery.loading}
          error={channelsQuery.error}
          onRetry={channelsQuery.refetch}
        >
          {channels.length > 0 ? (
            <div className="flex flex-col lg:flex-row gap-[var(--space-3)] items-stretch">
              {channels.map((ch, idx) => (
                <div key={ch.channel} className="flex items-center gap-[var(--space-3)]">
                  <div className="card flex-1 min-w-[220px]">
                    <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-2)]">
                      <span
                        className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                          ch.channel === "production"
                            ? "bg-status-live"
                            : ch.channel === "staging"
                              ? "bg-status-warning"
                              : "bg-text-muted"
                        }`}
                      />
                      <span className="text-[var(--text-sm)] font-semibold text-text-primary uppercase">
                        {ch.channel}
                      </span>
                    </div>
                    <div className="space-y-[var(--space-1)] text-[var(--text-xs)]">
                      <div className="flex justify-between">
                        <span className="text-text-muted">Version</span>
                        <span className="text-text-primary font-mono">{ch.version ?? "--"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-muted">Hash</span>
                        <span className="text-text-muted font-mono">
                          {ch.config_hash ? ch.config_hash.slice(0, 12) + "..." : "--"}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-muted">By</span>
                        <span className="text-text-secondary">{ch.promoted_by ?? "--"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-muted">At</span>
                        <span className="text-text-muted">{formatDate(ch.promoted_at)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Promote arrow between channels */}
                  {idx < channels.length - 1 && (
                    <button
                      onClick={() =>
                        handlePromote(ch.channel, channels[idx + 1].channel)
                      }
                      disabled={promoting !== null}
                      className="btn btn-ghost text-accent hover:bg-accent/10 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] flex items-center justify-center flex-shrink-0"
                      title={`Promote ${ch.channel} to ${channels[idx + 1].channel}`}
                    >
                      {promoting === `${ch.channel}->${channels[idx + 1].channel}` ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <ArrowRight size={16} />
                      )}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Rocket size={28} />}
              title="No release channels"
              description="Release channels will appear here once configured."
            />
          )}
        </QueryState>
      </section>

      {/* Section B: Canary Configuration */}
      <section>
        <h2 className="text-[var(--text-md)] font-semibold text-text-primary mb-[var(--space-4)]">
          Canary Configuration
        </h2>
        <QueryState
          loading={canaryQuery.loading}
          error={canaryQuery.error}
          onRetry={canaryQuery.refetch}
        >
          {canaryActive && canary ? (
            <div className="card">
              <div className="flex items-center justify-between mb-[var(--space-4)]">
                <div className="flex items-center gap-[var(--space-2)]">
                  <span className="inline-block w-2 h-2 rounded-full bg-status-live animate-pulse" />
                  <span className="text-[var(--text-sm)] font-semibold text-text-primary">
                    Canary Active
                  </span>
                </div>
                <button
                  onClick={handleRemoveCanary}
                  className="btn btn-ghost text-status-error text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                >
                  <Trash2 size={12} />
                  Remove Canary
                </button>
              </div>

              <div className="grid grid-cols-2 gap-[var(--space-4)] mb-[var(--space-4)]">
                <div>
                  <span className="text-[var(--text-xs)] text-text-muted block mb-[var(--space-1)]">
                    Primary Version
                  </span>
                  <span className="text-[var(--text-sm)] text-text-primary font-mono">
                    {canary.primary_version ?? "--"}
                  </span>
                </div>
                <div>
                  <span className="text-[var(--text-xs)] text-text-muted block mb-[var(--space-1)]">
                    Canary Version
                  </span>
                  <span className="text-[var(--text-sm)] text-accent font-mono">
                    {canary.canary_version ?? "--"}
                  </span>
                </div>
              </div>

              {/* Traffic split visualization */}
              <div className="mb-[var(--space-4)]">
                <span className="text-[var(--text-xs)] text-text-muted block mb-[var(--space-2)]">
                  Traffic Split
                </span>
                <div className="h-6 rounded-lg overflow-hidden flex">
                  <div
                    className="bg-accent flex items-center justify-center text-[10px] font-semibold text-text-inverse transition-all"
                    style={{ width: `${100 - (canary.canary_weight ?? 0)}%` }}
                  >
                    {100 - (canary.canary_weight ?? 0)}% primary
                  </div>
                  <div
                    className="flex items-center justify-center text-[10px] font-semibold text-text-inverse transition-all"
                    style={{
                      width: `${canary.canary_weight ?? 0}%`,
                      backgroundColor: "var(--color-chart-orange)",
                    }}
                  >
                    {(canary.canary_weight ?? 0) > 5 ? `${canary.canary_weight}% canary` : ""}
                  </div>
                </div>
              </div>

              {/* Weight slider */}
              <div>
                <label className="text-[var(--text-xs)] text-text-muted block mb-[var(--space-2)]">
                  Canary Weight: {canary.canary_weight ?? 0}%
                </label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={canary.canary_weight ?? 0}
                  onChange={(e) => handleUpdateCanaryWeight(Number(e.target.value))}
                  className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                  style={{
                    background: `linear-gradient(to right, var(--color-chart-orange) ${canary.canary_weight ?? 0}%, var(--color-surface-overlay) ${canary.canary_weight ?? 0}%)`,
                  }}
                />
                <div className="flex justify-between text-[10px] text-text-muted mt-[var(--space-1)]">
                  <span>0% (all primary)</span>
                  <span>100% (all canary)</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="card flex items-center justify-between">
              <div>
                <p className="text-[var(--text-sm)] text-text-primary font-medium">
                  No active canary deployment
                </p>
                <p className="text-[var(--text-xs)] text-text-muted">
                  Split traffic between two versions to test safely before full rollout.
                </p>
              </div>
              <button
                onClick={() => setCanaryModalOpen(true)}
                className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
              >
                <Plus size={14} />
                Set Up Canary
              </button>
            </div>
          )}
        </QueryState>
      </section>

      {/* Section C: Version History */}
      <section>
        <h2 className="text-[var(--text-md)] font-semibold text-text-primary mb-[var(--space-4)]">
          Version History
        </h2>
        <QueryState
          loading={versionsQuery.loading}
          error={versionsQuery.error}
          onRetry={versionsQuery.refetch}
        >
          {versions.length > 0 ? (
            <div className="card">
              <div className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 28 }}></th>
                      <th>Version</th>
                      <th>Created By</th>
                      <th>Created At</th>
                      <th style={{ width: 80 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v, idx) => {
                      const isExpanded = diffRow === v.version;
                      const diffs = isExpanded ? getDiff(idx) : [];
                      return (
                        <>
                          <tr key={v.version}>
                            <td>
                              {isExpanded ? (
                                <ChevronDown size={12} className="text-text-muted" />
                              ) : (
                                <ChevronRight size={12} className="text-text-muted" />
                              )}
                            </td>
                            <td className="font-mono text-[var(--text-sm)] text-text-primary">
                              {v.version}
                            </td>
                            <td className="text-[var(--text-sm)] text-text-secondary">
                              {v.created_by ?? "--"}
                            </td>
                            <td className="text-[var(--text-xs)] text-text-muted">
                              {formatDate(v.created_at)}
                            </td>
                            <td>
                              {idx < versions.length - 1 && (
                                <button
                                  onClick={() =>
                                    setDiffRow(isExpanded ? null : v.version)
                                  }
                                  className="btn btn-ghost text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                                >
                                  Diff
                                </button>
                              )}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr key={`${v.version}-diff`}>
                              <td colSpan={5} className="bg-surface-base">
                                {diffs.length > 0 ? (
                                  <div className="p-[var(--space-3)] font-mono text-[var(--text-xs)] space-y-[var(--space-1)]">
                                    {diffs.map((d) => (
                                      <div key={d.key}>
                                        <span className="text-text-muted">{d.key}:</span>
                                        <div className="ml-[var(--space-4)]">
                                          <div className="text-status-error">
                                            <Minus size={10} className="inline mr-1" />
                                            {d.old}
                                          </div>
                                          <div className="text-status-live">
                                            <Plus size={10} className="inline mr-1" />
                                            {d.new}
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-[var(--text-xs)] text-text-muted p-[var(--space-3)]">
                                    No config differences found, or config data not available.
                                  </p>
                                )}
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<Rocket size={28} />}
              title="No versions"
              description="Version history will appear here as you make changes."
            />
          )}
        </QueryState>
      </section>

      {/* Canary Setup Modal */}
      {canaryModalOpen && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/50"
            onClick={() => setCanaryModalOpen(false)}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-[var(--space-4)]">
            <div
              className="glass-dropdown border border-border-default rounded-2xl shadow-2xl w-full max-w-md"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between p-[var(--space-4)] border-b border-border-default">
                <h3 className="text-[var(--text-md)] font-semibold text-text-primary">
                  Set Up Canary Deployment
                </h3>
                <button
                  onClick={() => setCanaryModalOpen(false)}
                  className="p-[var(--space-2)] rounded-lg hover:bg-surface-overlay transition-colors min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] flex items-center justify-center"
                >
                  <X size={16} className="text-text-muted" />
                </button>
              </div>
              <div className="p-[var(--space-4)] space-y-[var(--space-4)]">
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Primary Version
                  </label>
                  <input
                    type="text"
                    value={canaryPrimary}
                    onChange={(e) => setCanaryPrimary(e.target.value)}
                    placeholder="e.g., v1.2.0"
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Canary Version
                  </label>
                  <input
                    type="text"
                    value={canaryVersion}
                    onChange={(e) => setCanaryVersion(e.target.value)}
                    placeholder="e.g., v1.3.0-beta"
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-2)]">
                    Canary Traffic Weight: {canaryWeight}%
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={canaryWeight}
                    onChange={(e) => setCanaryWeight(Number(e.target.value))}
                    className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                    style={{
                      background: `linear-gradient(to right, var(--color-chart-orange) ${canaryWeight}%, var(--color-surface-overlay) ${canaryWeight}%)`,
                    }}
                  />
                  <div className="flex justify-between text-[10px] text-text-muted mt-[var(--space-1)]">
                    <span>0%</span>
                    <span>100%</span>
                  </div>

                  {/* Preview bar */}
                  <div className="h-4 rounded-lg overflow-hidden flex mt-[var(--space-2)]">
                    <div
                      className="bg-accent flex items-center justify-center text-[9px] font-semibold text-text-inverse"
                      style={{ width: `${100 - canaryWeight}%` }}
                    >
                      {100 - canaryWeight > 10 ? `${100 - canaryWeight}%` : ""}
                    </div>
                    <div
                      className="flex items-center justify-center text-[9px] font-semibold text-text-inverse"
                      style={{
                        width: `${canaryWeight}%`,
                        backgroundColor: "var(--color-chart-orange)",
                      }}
                    >
                      {canaryWeight > 10 ? `${canaryWeight}%` : ""}
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-[var(--space-2)] p-[var(--space-4)] border-t border-border-default">
                <button
                  onClick={() => setCanaryModalOpen(false)}
                  className="btn btn-ghost text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSetCanary}
                  disabled={canarySubmitting || !canaryPrimary || !canaryVersion}
                  className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                >
                  {canarySubmitting ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Rocket size={14} />
                  )}
                  Deploy Canary
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
