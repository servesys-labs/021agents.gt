export const KnowledgeTab = ({ agentName }: { agentName: string }) => (
  <div className="card">
    <h3 className="text-sm font-semibold text-text-primary mb-2">Knowledge Base</h3>
    <p className="text-sm text-text-muted">
      Knowledge sources attached to <span className="font-mono text-text-secondary">{agentName}</span>.
    </p>
    <div className="mt-4 border border-border-default rounded-md p-6 flex items-center justify-center">
      <p className="text-xs text-text-muted">No knowledge sources configured yet.</p>
    </div>
  </div>
);
