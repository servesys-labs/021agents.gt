import { Rocket, Loader2 } from "lucide-react";

type Props = {
  selectedNodeId?: string | null;
  selectedNodeType?: string | null;
  onDeploy: (nodeId: string) => void;
  isDeploying: boolean;
};

export function DeployButton({ selectedNodeId, selectedNodeType, onDeploy, isDeploying }: Props) {
  if (!selectedNodeId || selectedNodeType !== "agent") return null;

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40">
      <button
        onClick={() => onDeploy(selectedNodeId)}
        disabled={isDeploying}
        className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-accent text-text-inverse text-[length:var(--text-base)] font-semibold hover:bg-accent-hover transition-all shadow-[var(--shadow-node)] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isDeploying ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            <span>Deploying...</span>
          </>
        ) : (
          <>
            <Rocket size={14} />
            <span>Deploy Agent</span>
          </>
        )}
      </button>
    </div>
  );
}
