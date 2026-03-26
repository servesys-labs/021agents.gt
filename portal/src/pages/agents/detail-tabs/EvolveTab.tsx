export const EvolveTab = ({ agentName }: { agentName: string }) => (
  <div className="card">
    <h3 className="text-sm font-semibold text-text-primary mb-2">Evolve</h3>
    <p className="text-sm text-text-muted mb-4">
      Evolutionary optimization settings for{" "}
      <span className="font-mono text-text-secondary">{agentName}</span>.
    </p>
    <div className="border border-border-default rounded-md p-6 flex items-center justify-center">
      <p className="text-xs text-text-muted">No evolution runs configured.</p>
    </div>
  </div>
);
