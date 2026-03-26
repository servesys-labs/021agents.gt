import { type AgentConfig } from "../../../lib/adapters";

export const ConfigTab = ({ agent }: { agent: AgentConfig }) => (
  <div className="card">
    <h3 className="text-sm font-semibold text-text-primary mb-3">Configuration</h3>
    <pre className="text-xs font-mono text-text-secondary bg-surface-base border border-border-default rounded-md p-4 overflow-x-auto max-h-[60vh] whitespace-pre-wrap">
      {JSON.stringify(agent, null, 2)}
    </pre>
  </div>
);
