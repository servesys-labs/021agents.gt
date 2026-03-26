import { useState, useCallback } from "react";
import { useReactFlow } from "@xyflow/react";
import {
  Plus,
  Minus,
  Maximize2,
  Undo2,
  Redo2,
  Layers,
  Grid3x3,
  Network,
  GitFork,
  Bot,
  LayoutGrid,
} from "lucide-react";

/* ── Railway-style vertical canvas controls ───────────────────
   Four grouped clusters stacked vertically on the left side:
   1. Grid toggle
   2. Zoom in / Zoom out / Fit view
   3. Undo / Redo
   4. Layers (with flyout including Agents Only toggle)
   ──────────────────────────────────────────────────────────── */

interface CanvasControlsProps {
  showGrid: boolean;
  onToggleGrid: () => void;
  agentsOnly: boolean;
  onToggleAgentsOnly: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  hiddenLayers: Set<string>;
  onToggleLayer: (layer: string) => void;
}

export function CanvasControls({
  showGrid,
  onToggleGrid,
  agentsOnly,
  onToggleAgentsOnly,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  hiddenLayers,
  onToggleLayer,
}: CanvasControlsProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const [layersOpen, setLayersOpen] = useState(false);

  const handleZoomIn = useCallback(() => {
    zoomIn({ duration: 200 });
  }, [zoomIn]);

  const handleZoomOut = useCallback(() => {
    zoomOut({ duration: 200 });
  }, [zoomOut]);

  const handleFitView = useCallback(() => {
    fitView({ padding: 0.2, duration: 300 });
  }, [fitView]);

  return (
    <div className="absolute bottom-14 left-4 z-30 flex flex-col gap-2">
      {/* ── Cluster 1: Grid toggle ─────────────────────────── */}
      <div className="glass-dropdown rounded-xl border border-border-default overflow-hidden">
        <ControlButton
          onClick={onToggleGrid}
          active={showGrid}
          title="Toggle grid"
        >
          <Grid3x3 size={16} />
        </ControlButton>
      </div>

      {/* ── Cluster 2: Zoom controls ──────────────────────── */}
      <div className="glass-dropdown rounded-xl border border-border-default overflow-hidden flex flex-col divide-y divide-border-default">
        <ControlButton onClick={handleZoomIn} title="Zoom in">
          <Plus size={16} />
        </ControlButton>
        <ControlButton onClick={handleZoomOut} title="Zoom out">
          <Minus size={16} />
        </ControlButton>
        <ControlButton onClick={handleFitView} title="Fit to view">
          <Maximize2 size={14} />
        </ControlButton>
      </div>

      {/* ── Cluster 3: Undo / Redo ────────────────────────── */}
      <div className="glass-dropdown rounded-xl border border-border-default overflow-hidden flex flex-col divide-y divide-border-default">
        <ControlButton
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo"
        >
          <Undo2 size={15} />
        </ControlButton>
        <ControlButton
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo"
        >
          <Redo2 size={15} />
        </ControlButton>
      </div>

      {/* ── Cluster 4: Layers ─────────────────────────────── */}
      <div className="relative">
        <div className="glass-dropdown rounded-xl border border-border-default overflow-hidden">
          <ControlButton
            onClick={() => setLayersOpen(!layersOpen)}
            active={layersOpen}
            title="Layers"
          >
            <Layers size={15} />
          </ControlButton>
        </div>

        {/* Layers flyout */}
        {layersOpen && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setLayersOpen(false)} />
            <div
              className="absolute left-full bottom-0 ml-2 z-30 w-60 glass-dropdown rounded-xl border border-border-default overflow-hidden shadow-lg animate-[fadeIn_0.1s_ease-out]"
            >
              {/* Agents Only toggle */}
              <LayerToggleItem
                icon={agentsOnly ? <LayoutGrid size={16} /> : <Bot size={16} />}
                label={agentsOnly ? "Show All Nodes" : "Agents Only"}
                description={agentsOnly ? "Restore all nodes and connections" : "Hide everything except agents"}
                active={agentsOnly}
                onClick={onToggleAgentsOnly}
              />
              <div className="h-px bg-border-default" />
              <LayerToggleItem
                icon={<Network size={16} />}
                label="Network Traffic"
                description={hiddenLayers.has("network") ? "Edges are hidden" : "Show traffic between services"}
                active={!hiddenLayers.has("network")}
                onClick={() => onToggleLayer("network")}
                hidden={hiddenLayers.has("network")}
              />
              <div className="h-px bg-border-default" />
              <LayerToggleItem
                icon={<GitFork size={16} />}
                label="Variable References"
                description={hiddenLayers.has("variables") ? "Non-agent nodes are hidden" : "Show variable connections"}
                active={!hiddenLayers.has("variables")}
                onClick={() => onToggleLayer("variables")}
                hidden={hiddenLayers.has("variables")}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Control button ────────────────────────────────────────── */
function ControlButton({
  children,
  onClick,
  active = false,
  disabled = false,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`
        flex items-center justify-center w-10 h-10 transition-colors
        ${disabled
          ? "text-text-muted/40 cursor-not-allowed"
          : active
            ? "text-text-primary bg-surface-overlay/60"
            : "text-text-muted hover:text-text-primary hover:bg-surface-overlay/40"
        }
      `}
    >
      {children}
    </button>
  );
}

/* ── Layer toggle item (with active state indicator) ──────── */
function LayerToggleItem({
  icon,
  label,
  description,
  active,
  onClick,
  hidden = false,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
  hidden?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 w-full px-3.5 py-3 text-left transition-colors ${
        hidden ? "opacity-50 hover:opacity-75" : active ? "bg-accent/10" : "hover:bg-surface-overlay/40"
      }`}
    >
      <span className={`flex-shrink-0 ${hidden ? "text-text-muted" : active ? "text-accent" : "text-text-muted"}`}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className={`text-[12px] font-medium ${hidden ? "line-through text-text-muted" : active ? "text-accent" : "text-text-primary"}`}>{label}</p>
        <p className="text-[10px] text-text-muted">{description}</p>
      </div>
      {active && !hidden && (
        <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
      )}
    </button>
  );
}
