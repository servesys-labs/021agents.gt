import { createPortal } from "react-dom";
import { Bot, MessageSquare, ArrowRight, Rocket } from "lucide-react";

type Props = {
  onDismiss: () => void;
  onStartScratch: () => void;
  onOpenMetaAgent: () => void;
};

export function WelcomeOverlay({ onDismiss, onStartScratch, onOpenMetaAgent }: Props) {
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center glass-backdrop">
      <div
        className="w-full max-w-lg glass-medium border border-border-default rounded-2xl overflow-hidden"
        style={{ boxShadow: "var(--shadow-panel)", animation: "overlayIn 0.3s ease-out" }}
      >
        {/* Header */}
        <div className="px-8 pt-8 pb-4 text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-accent/10 flex items-center justify-center">
            <Rocket size={28} className="text-accent" />
          </div>
          <h1 className="text-xl font-bold text-text-primary mb-2">Welcome to oneshots.co</h1>
          <p className="text-sm text-text-muted">Your workspace is ready. How would you like to start?</p>
        </div>

        {/* Options */}
        <div className="px-8 pb-4 space-y-3">
          <button
            onClick={() => { onOpenMetaAgent(); onDismiss(); }}
            className="w-full flex items-center gap-4 p-4 rounded-xl bg-accent/5 border border-accent/20 hover:bg-accent/10 hover:border-accent/40 transition-all group text-left"
          >
            <div className="p-2.5 rounded-lg bg-accent/10">
              <MessageSquare size={20} className="text-accent" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-text-primary">Chat with Meta-Agent</p>
              <p className="text-xs text-text-muted mt-0.5">Describe what you need and the AI will build your agents</p>
            </div>
            <ArrowRight size={16} className="text-text-muted group-hover:text-accent transition-colors" />
          </button>

          <button
            onClick={() => { onStartScratch(); onDismiss(); }}
            className="w-full flex items-center gap-4 p-4 rounded-xl bg-white-alpha-5 border border-border-default hover:bg-white-alpha-8 hover:border-border-strong transition-all group text-left"
          >
            <div className="p-2.5 rounded-lg bg-surface-overlay">
              <Bot size={20} className="text-chart-purple" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-text-primary">Start from scratch</p>
              <p className="text-xs text-text-muted mt-0.5">Add agents, connectors, and data sources manually</p>
            </div>
            <ArrowRight size={16} className="text-text-muted group-hover:text-accent transition-colors" />
          </button>
        </div>

        {/* Footer */}
        <div className="px-8 pb-8 pt-2">
          <p className="text-[10px] text-text-muted text-center">
            Press <kbd className="px-1.5 py-0.5 rounded bg-surface-overlay border border-border-default text-text-muted font-mono">Cmd+K</kbd> anytime to open the command palette
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
