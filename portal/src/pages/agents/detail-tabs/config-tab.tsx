import type { AgentConfig } from "../../../lib/adapters";

type ConfigTabProps = {
  config: AgentConfig | null;
  loading: boolean;
};

export function ConfigTab({ config, loading }: ConfigTabProps) {
  if (loading) {
    return <p className="text-[var(--text-sm)] text-text-muted">Loading config...</p>;
  }

  if (!config) {
    return <p className="text-[var(--text-sm)] text-text-muted">No config available</p>;
  }

  const fields: { label: string; value: string }[] = [
    { label: "Name", value: config.name },
    { label: "Description", value: config.description || "--" },
    { label: "Model", value: config.model },
    { label: "System Prompt", value: config.system_prompt || "--" },
    { label: "Temperature", value: String(config.temperature ?? "--") },
    { label: "Max Tokens", value: String(config.max_tokens ?? "--") },
    { label: "Max Turns", value: String(config.max_turns ?? "--") },
    { label: "Timeout", value: `${config.timeout_seconds ?? "--"}s` },
    { label: "Tools", value: config.tools?.join(", ") || "None" },
    { label: "Tags", value: config.tags?.join(", ") || "None" },
    { label: "Budget Limit", value: `$${config.governance?.budget_limit_usd ?? "--"}` },
  ];

  return (
    <div className="max-w-2xl">
      <div className="card space-y-[var(--space-4)]">
        {fields.map((field) => (
          <div key={field.label}>
            <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              {field.label}
            </label>
            <p
              className={`text-[var(--text-sm)] text-text-primary ${
                field.label === "System Prompt" ? "font-mono whitespace-pre-wrap" : ""
              }`}
            >
              {field.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
