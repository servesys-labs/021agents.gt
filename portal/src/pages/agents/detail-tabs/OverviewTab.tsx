import { type AgentConfig } from "../../../lib/adapters";

export const OverviewTab = ({ agent }: { agent: AgentConfig }) => (
  <div className="space-y-6">
    <div className="card">
      <h3 className="text-sm font-semibold text-text-primary mb-3">Agent Overview</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Model</span>
          <span className="text-sm text-text-secondary font-mono">{agent.model}</span>
        </div>
        <div>
          <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Version</span>
          <span className="text-sm text-text-secondary font-mono">{agent.version || "1.0.0"}</span>
        </div>
        <div>
          <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Max Tokens</span>
          <span className="text-sm text-text-secondary">{agent.max_tokens?.toLocaleString()}</span>
        </div>
        <div>
          <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">Temperature</span>
          <span className="text-sm text-text-secondary">{agent.temperature}</span>
        </div>
      </div>
    </div>
    {agent.description && (
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-2">Description</h3>
        <p className="text-sm text-text-secondary leading-relaxed">{agent.description}</p>
      </div>
    )}
    {agent.system_prompt && (
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-2">System Prompt</h3>
        <pre className="text-xs font-mono text-text-secondary bg-surface-base border border-border-default rounded-md p-4 overflow-x-auto max-h-60 whitespace-pre-wrap">
          {agent.system_prompt}
        </pre>
      </div>
    )}
  </div>
);
