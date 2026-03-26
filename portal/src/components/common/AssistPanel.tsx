import { Sparkles } from "lucide-react";
import { useMetaAgent } from "../../providers/MetaAgentProvider";

/* ── AssistPanel ────────────────────────────────────────────────── */
/*
 * Inline, context-aware suggestion bar that appears on key pages.
 * Renders as a subtle row of chips that open the meta-agent chat
 * with a pre-filled prompt. Designed to feel ambient, not intrusive.
 */

type AssistPanelProps = {
  /** Override suggestions (e.g., from a specific page context) */
  customSuggestions?: Array<{ label: string; prompt: string }>;
  /** Optional heading text */
  heading?: string;
  /** Compact mode — no heading, smaller chips */
  compact?: boolean;
};

export function AssistPanel({ customSuggestions, heading, compact }: AssistPanelProps) {
  const { suggestions: contextSuggestions, send, openPanel } = useMetaAgent();

  const items = customSuggestions ?? contextSuggestions;

  if (items.length === 0) return null;

  const handleClick = (prompt: string) => {
    openPanel();
    void send(prompt);
  };

  if (compact) {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <Sparkles size={11} className="text-accent flex-shrink-0" />
        {items.map((s) => (
          <button
            key={s.label}
            onClick={() => handleClick(s.prompt)}
            className="px-2 py-1 text-[10px] font-medium text-text-muted bg-surface-base border border-border-default rounded-md hover:border-accent/30 hover:text-accent transition-colors"
          >
            {s.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-accent/15 bg-accent/[0.03] p-3">
      {heading && (
        <div className="flex items-center gap-1.5 mb-2.5">
          <Sparkles size={12} className="text-accent" />
          <p className="text-[11px] font-semibold text-text-secondary">
            {heading}
          </p>
        </div>
      )}
      {!heading && (
        <div className="flex items-center gap-1.5 mb-2.5">
          <Sparkles size={12} className="text-accent" />
          <p className="text-[11px] font-semibold text-text-secondary">
            Meta-Agent Assist
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {items.map((s) => (
          <button
            key={s.label}
            onClick={() => handleClick(s.prompt)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-text-secondary bg-surface-base border border-border-default rounded-lg hover:border-accent/30 hover:text-accent transition-colors"
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── AssistInlineHint ────────────────────────────────────────────── */
/*
 * Single-line hint that appears contextually.
 * For example: "Meta-agent can analyze this trace" with a clickable action.
 */

type AssistInlineHintProps = {
  message: string;
  actionLabel: string;
  prompt: string;
};

export function AssistInlineHint({ message, actionLabel, prompt }: AssistInlineHintProps) {
  const { send, openPanel } = useMetaAgent();

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/[0.05] border border-accent/10">
      <Sparkles size={12} className="text-accent flex-shrink-0" />
      <p className="text-[11px] text-text-muted flex-1">{message}</p>
      <button
        onClick={() => {
          openPanel();
          void send(prompt);
        }}
        className="text-[11px] font-medium text-accent hover:text-accent-hover transition-colors whitespace-nowrap"
      >
        {actionLabel} &rarr;
      </button>
    </div>
  );
}
