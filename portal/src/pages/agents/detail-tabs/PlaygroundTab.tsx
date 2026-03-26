export const PlaygroundTab = ({ agentName }: { agentName: string }) => (
  <div className="card">
    <h3 className="text-sm font-semibold text-text-primary mb-2">Playground</h3>
    <p className="text-sm text-text-muted mb-4">
      Test <span className="font-mono text-text-secondary">{agentName}</span> in a live sandbox.
    </p>
    <div className="border border-border-default rounded-md p-8 flex items-center justify-center bg-surface-base">
      <p className="text-xs text-text-muted">Playground session will appear here.</p>
    </div>
  </div>
);
