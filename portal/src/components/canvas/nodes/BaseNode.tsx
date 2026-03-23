import { type ReactNode } from "react";
import { Handle, Position, useNodeConnections } from "@xyflow/react";

/** Shared glass-node style object to avoid inline duplication */
const GLASS_STYLE = {
  background: "var(--color-glass-heavy)",
  backdropFilter: "blur(40px) saturate(1.8)",
  WebkitBackdropFilter: "blur(40px) saturate(1.8)",
} as const;

export type BaseNodeProps = {
  /** Tailwind border-color class for the accent (e.g. "accent", "chart-green") */
  accentColor: string;
  /** Tailwind shadow token class for selected glow */
  selectedShadow: string;
  /** Tailwind bg class for the accent strip */
  stripColor: string;
  /** Whether the node is selected */
  selected?: boolean;
  /** Min/max width Tailwind classes */
  widthClasses?: string;
  children: ReactNode;
};

/**
 * Shared wrapper for all canvas node types.
 * Provides: glass background, connection handles, accent strip, selected glow.
 */
export function BaseNode({
  accentColor,
  selectedShadow,
  stripColor,
  selected,
  widthClasses = "min-w-[190px] max-w-[220px]",
  children,
}: BaseNodeProps) {
  const sourceConns = useNodeConnections({ handleType: "source" });
  const targetConns = useNodeConnections({ handleType: "target" });
  const hasSource = sourceConns.length > 0;
  const hasTarget = targetConns.length > 0;

  return (
    <div
      className={`
        relative ${widthClasses} rounded-xl border transition-all duration-200
        ${selected
          ? `border-${accentColor} ${selectedShadow}`
          : "border-border-default hover:border-border-strong"
        }
      `}
      style={GLASS_STYLE}
    >
      {/* Connection handles — only visible when connected */}
      <Handle
        type="target"
        position={Position.Left}
        className={`!w-2.5 !h-2.5 !border-2 !border-${accentColor} !-left-[5px] transition-all ${
          hasTarget ? `!bg-surface-overlay hover:!bg-${accentColor} !opacity-100` : "!opacity-0 !pointer-events-none"
        }`}
      />
      <Handle
        type="source"
        position={Position.Right}
        className={`!w-2.5 !h-2.5 !border-2 !border-${accentColor} !-right-[5px] transition-all ${
          hasSource ? `!bg-surface-overlay hover:!bg-${accentColor} !opacity-100` : "!opacity-0 !pointer-events-none"
        }`}
      />

      {/* Accent strip */}
      <div className={`absolute top-0 left-4 right-4 h-[2px] rounded-b ${stripColor} opacity-60`} />

      {children}
    </div>
  );
}
