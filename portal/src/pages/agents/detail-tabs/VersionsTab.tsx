import { useState } from "react";
import { useApiQuery, apiPost } from "../../../lib/api";
import {
  GitBranch, Clock, RotateCcw, ChevronDown, ChevronRight,
  ArrowRight, User, FileCode, Trash2, AlertTriangle,
} from "lucide-react";

interface VersionCommit {
  id: string;
  tree_id: string;
  parent_id: string | null;
  message: string;
  author: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface DiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
}

interface TrashEntry {
  id: string;
  path: string;
  deleted_at: number;
  deleted_by: string;
  expires_at: number;
  reason: string;
}

export const VersionsTab = ({ agentName }: { agentName: string }) => {
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [diffFrom, setDiffFrom] = useState<string | null>(null);
  const [diffTo, setDiffTo] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [showTrash, setShowTrash] = useState(false);

  const versionsQuery = useApiQuery<{ versions: VersionCommit[]; total: number }>(
    `/api/v1/agents/${agentName}/versions`,
  );
  const trashQuery = useApiQuery<{ trash: TrashEntry[] }>(
    `/api/v1/agents/${agentName}/trash`,
  );

  const versions = versionsQuery.data?.versions || [];
  const trash = trashQuery.data?.trash || [];

  async function restoreVersion(commitId: string) {
    await apiPost(`/api/v1/agents/${agentName}/versions/${commitId}/restore`);
    setConfirmRestore(null);
    versionsQuery.refetch();
  }

  async function restoreFromTrash(trashId: string) {
    await apiPost(`/api/v1/agents/${agentName}/trash/${trashId}/restore`);
    trashQuery.refetch();
  }

  return (
    <div className="space-y-6">
      {/* ── Version Timeline ──────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <GitBranch size={16} /> Config Version History
          </h3>
          <span className="text-xs text-text-muted">
            {versions.length} version{versions.length !== 1 ? "s" : ""}
          </span>
        </div>

        {versions.length === 0 && !versionsQuery.loading && (
          <div className="border border-border-default rounded-md p-8 flex flex-col items-center">
            <GitBranch size={24} className="text-text-muted mb-2" />
            <p className="text-xs text-text-muted">No version history yet. Versions are created automatically on every config change.</p>
          </div>
        )}

        {versions.length > 0 && (
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-[11px] top-3 bottom-3 w-px bg-border-default" />

            <div className="space-y-0">
              {versions.map((version, i) => {
                const isLatest = i === 0;
                const isSelected = selectedVersion === version.id;
                const date = new Date(version.timestamp);

                return (
                  <div key={version.id} className="relative pl-8 py-2.5">
                    {/* Timeline dot */}
                    <div className={`absolute left-[7px] top-4 w-[9px] h-[9px] rounded-full border-2 ${
                      isLatest ? "bg-accent border-accent" : "bg-surface-raised border-border-default"
                    }`} />

                    <button
                      onClick={() => setSelectedVersion(isSelected ? null : version.id)}
                      className="w-full text-left group"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          {isSelected ? <ChevronDown size={12} className="text-text-muted shrink-0" /> : <ChevronRight size={12} className="text-text-muted shrink-0" />}
                          <span className={`text-xs font-medium truncate ${isLatest ? "text-accent" : "text-text-primary"}`}>
                            {version.message}
                          </span>
                          {isLatest && (
                            <span className="text-[9px] uppercase font-bold text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                              current
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0 text-[10px] text-text-muted">
                          <span className="flex items-center gap-1">
                            <User size={10} /> {version.author}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock size={10} /> {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                      </div>

                      {/* Expanded: show actions */}
                      {isSelected && (
                        <div className="mt-2 pl-5 flex items-center gap-2">
                          <span className="text-[10px] text-text-muted font-mono">{version.id.slice(0, 12)}</span>
                          {typeof (version.metadata as Record<string, unknown>)?.source === "string" && (
                            <span className="text-[10px] text-text-muted bg-surface-base px-1.5 py-0.5 rounded">
                              {(version.metadata as Record<string, string>).source}
                            </span>
                          )}
                          {!isLatest && (
                            confirmRestore === version.id ? (
                              <div className="flex items-center gap-1.5 ml-auto">
                                <span className="text-[10px] text-status-error">Restore this version?</span>
                                <button
                                  onClick={(e) => { e.stopPropagation(); restoreVersion(version.id); }}
                                  className="btn btn-primary text-[10px] py-0.5 px-2"
                                >
                                  Confirm
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setConfirmRestore(null); }}
                                  className="btn btn-ghost text-[10px] py-0.5 px-2"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={(e) => { e.stopPropagation(); setConfirmRestore(version.id); }}
                                className="btn btn-ghost text-[10px] py-0.5 px-2 flex items-center gap-1 ml-auto"
                              >
                                <RotateCcw size={10} /> Restore
                              </button>
                            )
                          )}
                        </div>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Trash / Recycle Bin ────────────────────────────────── */}
      <div className="card">
        <button
          onClick={() => setShowTrash(!showTrash)}
          className="flex items-center justify-between w-full"
        >
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Trash2 size={16} /> Recycle Bin
          </h3>
          <div className="flex items-center gap-2">
            {trash.length > 0 && (
              <span className="text-[10px] text-text-muted bg-surface-base px-1.5 py-0.5 rounded">
                {trash.length} item{trash.length !== 1 ? "s" : ""}
              </span>
            )}
            {showTrash ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
          </div>
        </button>

        {showTrash && (
          <div className="mt-3">
            {trash.length === 0 && (
              <p className="text-xs text-text-muted py-4 text-center">Recycle bin is empty.</p>
            )}
            {trash.map((entry) => {
              const deletedDate = new Date(entry.deleted_at);
              const expiresDate = new Date(entry.expires_at);
              const daysLeft = Math.max(0, Math.ceil((entry.expires_at - Date.now()) / 86400_000));

              return (
                <div key={entry.id} className="flex items-center justify-between py-2 border-b border-border-subtle last:border-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileCode size={12} className="text-text-muted shrink-0" />
                    <span className="text-xs text-text-secondary truncate">{entry.path}</span>
                    <span className="text-[10px] text-text-muted">
                      by {entry.deleted_by} on {deletedDate.toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-[10px] ${daysLeft < 7 ? "text-status-error" : "text-text-muted"}`}>
                      {daysLeft}d left
                    </span>
                    <button
                      onClick={() => restoreFromTrash(entry.id)}
                      className="btn btn-ghost text-[10px] py-0.5 px-2 flex items-center gap-1"
                    >
                      <RotateCcw size={10} /> Restore
                    </button>
                  </div>
                </div>
              );
            })}

            {trash.length > 0 && (
              <div className="flex items-center gap-1.5 mt-3 text-[10px] text-text-muted">
                <AlertTriangle size={10} />
                Items expire automatically after their retention period. Permanent deletion requires API confirmation.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
