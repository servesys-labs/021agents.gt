import { useState, useEffect } from "react";
import { X, Bot, Zap, Shield, Brain, Save, Loader2 } from "lucide-react";

type AgentConfig = {
  name: string;
  system_prompt: string;
  model: string;
  temperature: number;
  max_tokens: number;
  max_turns: number;
  tools: string[];
  budget_limit: number;
  timeout_seconds: number;
  approvalRequired: string;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  agentData: any;
  onSave: (config: AgentConfig) => Promise<void>;
  availableTools: string[];
};

const models = [
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "gemini-2.5-flash",
  "claude-sonnet-4",
  "claude-haiku-3.5",
];

type Tab = "general" | "tools" | "governance";

export function AgentConfigDrawer({ isOpen, onClose, agentData, onSave, availableTools }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("general");
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<AgentConfig>({
    name: "",
    system_prompt: "",
    model: "gpt-4.1-mini",
    temperature: 0.7,
    max_tokens: 4096,
    max_turns: 10,
    tools: [],
    budget_limit: 1.0,
    timeout_seconds: 300,
    approvalRequired: "Destructive actions",
  });

  useEffect(() => {
    if (agentData) {
      setConfig({
        name: agentData.name || "",
        system_prompt: agentData.systemPrompt || agentData.system_prompt || "",
        model: agentData.model || "gpt-4.1-mini",
        temperature: agentData.temperature ?? 0.7,
        max_tokens: agentData.max_tokens ?? 4096,
        max_turns: agentData.max_turns ?? 10,
        tools: agentData.tools || [],
        budget_limit: agentData.budget_limit ?? 1.0,
        timeout_seconds: agentData.timeout_seconds ?? 300,
        approvalRequired: agentData.approvalRequired || "Destructive actions",
      });
      setActiveTab("general");
    }
  }, [agentData]);

  const toggleTool = (tool: string) => {
    setConfig((prev) => ({
      ...prev,
      tools: prev.tools.includes(tool)
        ? prev.tools.filter((t) => t !== tool)
        : [...prev.tools, tool],
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(config);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "general", label: "General", icon: <Bot size={13} /> },
    { id: "tools", label: "Tools", icon: <Zap size={13} /> },
    { id: "governance", label: "Governance", icon: <Shield size={13} /> },
  ];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 glass-backdrop z-40 animate-[fadeIn_0.15s_ease-out]"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="config-drawer z-50">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-default">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent-muted flex items-center justify-center">
              <Bot size={16} className="text-accent" />
            </div>
            <div>
              <h2 className="text-[14px] font-semibold text-text-primary">
                {config.name || "New Agent"}
              </h2>
              <p className="text-[11px] text-text-muted">Configure agent settings</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-0 px-5 border-b border-border-default">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-[12px] font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-accent text-accent"
                  : "border-transparent text-text-muted hover:text-text-secondary"
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {activeTab === "general" && (
            <>
              {/* Name */}
              <div>
                <label className="block text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">
                  Agent Name
                </label>
                <input
                  type="text"
                  value={config.name}
                  onChange={(e) => setConfig((p) => ({ ...p, name: e.target.value }))}
                  placeholder="e.g., Support Bot"
                  className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-default text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
                />
              </div>

              {/* System Prompt */}
              <div>
                <label className="block text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">
                  System Prompt
                </label>
                <textarea
                  value={config.system_prompt}
                  onChange={(e) => setConfig((p) => ({ ...p, system_prompt: e.target.value }))}
                  placeholder="You are a helpful assistant that..."
                  rows={6}
                  className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-default text-[12px] text-text-primary font-mono outline-none focus:border-accent transition-colors resize-y leading-relaxed"
                />
              </div>

              {/* Model */}
              <div>
                <label className="block text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">
                  Model
                </label>
                <select
                  value={config.model}
                  onChange={(e) => setConfig((p) => ({ ...p, model: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-default text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
                >
                  {models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>

              {/* Temperature */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
                    Temperature
                  </label>
                  <span className="text-[12px] text-accent font-mono font-semibold">{config.temperature.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={config.temperature}
                  onChange={(e) => setConfig((p) => ({ ...p, temperature: parseFloat(e.target.value) }))}
                  className="w-full accent-accent h-1.5"
                />
                <div className="flex justify-between text-[9px] text-text-muted mt-1">
                  <span>Precise</span>
                  <span>Creative</span>
                </div>
              </div>

              {/* Max Tokens + Max Turns */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">
                    Max Tokens
                  </label>
                  <input
                    type="number"
                    value={config.max_tokens}
                    onChange={(e) => setConfig((p) => ({ ...p, max_tokens: parseInt(e.target.value) || 0 }))}
                    className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-default text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">
                    Max Turns
                  </label>
                  <input
                    type="number"
                    value={config.max_turns}
                    onChange={(e) => setConfig((p) => ({ ...p, max_turns: parseInt(e.target.value) || 0 }))}
                    className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-default text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
                  />
                </div>
              </div>
            </>
          )}

          {activeTab === "tools" && (
            <>
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
                    Available Tools
                  </label>
                  <span className="text-[11px] text-accent font-semibold">
                    {config.tools.length} selected
                  </span>
                </div>
                <div className="space-y-0.5 rounded-lg border border-border-default overflow-hidden">
                  {availableTools.length === 0 ? (
                    <div className="px-4 py-8 text-center">
                      <Zap size={20} className="text-text-muted mx-auto mb-2" />
                      <p className="text-[12px] text-text-muted">No tools available</p>
                      <p className="text-[11px] text-text-muted mt-1">Connect a Connector or MCP Server to add tools</p>
                    </div>
                  ) : (
                    availableTools.map((tool) => {
                      const isSelected = config.tools.includes(tool);
                      return (
                        <label
                          key={tool}
                          className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors ${
                            isSelected
                              ? "bg-accent-muted"
                              : "hover:bg-surface-overlay"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleTool(tool)}
                            className="accent-accent w-3.5 h-3.5 flex-shrink-0"
                          />
                          <div className="min-w-0">
                            <span className="text-[12px] text-text-primary font-mono block truncate">{tool}</span>
                          </div>
                          {isSelected && (
                            <span className="ml-auto text-[9px] text-accent font-semibold uppercase">Active</span>
                          )}
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          )}

          {activeTab === "governance" && (
            <>
              <div className="p-3 rounded-lg bg-[rgba(249,115,22,0.05)] border border-[rgba(249,115,22,0.15)]">
                <div className="flex items-center gap-2 mb-1.5">
                  <Shield size={13} className="text-accent" />
                  <span className="text-[11px] font-semibold text-accent">Safety Guardrails</span>
                </div>
                <p className="text-[11px] text-text-muted leading-relaxed">
                  Set budget and timeout limits to prevent runaway agent execution. These limits are enforced server-side.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">
                    Budget Limit ($)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={config.budget_limit}
                    onChange={(e) => setConfig((p) => ({ ...p, budget_limit: parseFloat(e.target.value) || 0 }))}
                    className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-default text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">
                    Timeout (sec)
                  </label>
                  <input
                    type="number"
                    value={config.timeout_seconds}
                    onChange={(e) => setConfig((p) => ({ ...p, timeout_seconds: parseInt(e.target.value) || 0 }))}
                    className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-default text-[13px] text-text-primary outline-none focus:border-accent transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">
                  Human Approval Required
                </label>
                <div className="space-y-2">
                  {["Destructive actions", "External API calls", "Budget > 50%", "Never"].map((option) => (
                    <label key={option} className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-overlay cursor-pointer transition-colors">
                      <input
                        type="radio"
                        name="approval"
                        className="accent-accent w-3.5 h-3.5"
                        checked={config.approvalRequired === option}
                        onChange={() => setConfig((p) => ({ ...p, approvalRequired: option }))}
                      />
                      <span className="text-[12px] text-text-secondary">{option}</span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border-default flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-[12px] text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !config.name.trim()}
            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-accent text-white text-[12px] font-semibold hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Save size={13} />
            )}
            <span>Save Agent</span>
          </button>
        </div>
      </div>
    </>
  );
}
