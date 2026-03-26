import { type AgentConfig } from "../../../lib/adapters";

export const ToolsTab = ({ agent }: { agent: AgentConfig }) => {
  const tools = agent.tools ?? [];

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-text-primary mb-3">
        Tools ({tools.length})
      </h3>
      {tools.length === 0 ? (
        <div className="border border-border-default rounded-md p-6 flex items-center justify-center">
          <p className="text-xs text-text-muted">No tools attached.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {tools.map((tool) => (
            <div
              key={tool}
              className="flex items-center gap-3 px-3 py-2 bg-surface-base border border-border-default rounded-md"
            >
              <span className="text-sm font-mono text-text-secondary">{tool}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
