import { type AgentConfig } from "../../../lib/adapters";

export const SecurityTab = ({ agent }: { agent: AgentConfig }) => (
  <div className="card">
    <h3 className="text-sm font-semibold text-text-primary mb-3">Security & Governance</h3>
    <div className="space-y-4">
      <div>
        <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">
          Budget Limit
        </span>
        <span className="text-sm text-text-secondary">
          ${agent.governance?.budget_limit_usd ?? "Not set"}
        </span>
      </div>
      <div>
        <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">
          Destructive Action Confirmation
        </span>
        <span className="text-sm text-text-secondary">
          {agent.governance?.require_confirmation_for_destructive ? "Required" : "Disabled"}
        </span>
      </div>
      <div>
        <span className="block text-xs text-text-muted uppercase tracking-wide mb-1">
          Blocked Tools
        </span>
        <span className="text-sm text-text-secondary">
          {agent.governance?.blocked_tools?.length
            ? agent.governance.blocked_tools.join(", ")
            : "None"}
        </span>
      </div>
    </div>
  </div>
);
