export const EvalTab = ({ agentName }: { agentName: string }) => (
  <div className="card">
    <h3 className="text-sm font-semibold text-text-primary mb-2">Evaluations</h3>
    <p className="text-sm text-text-muted mb-4">
      Evaluation suites and benchmark results for{" "}
      <span className="font-mono text-text-secondary">{agentName}</span>.
    </p>
    <div className="border border-border-default rounded-md p-6 flex items-center justify-center">
      <p className="text-xs text-text-muted">No evaluations run yet.</p>
    </div>
  </div>
);
