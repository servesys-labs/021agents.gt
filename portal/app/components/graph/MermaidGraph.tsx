/**
 * MermaidGraph Component
 * 
 * Renders a Mermaid diagram from graph spec or Mermaid syntax.
 * Supports interactivity, zooming, and node selection.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import mermaid from "mermaid";
import type { GraphSpec } from "~/lib/runtime-types";
import {
  generateMermaidDiagram,
  type MermaidDiagramOptions,
} from "./mermaid-integration";

interface MermaidGraphProps {
  /** Graph specification or Mermaid syntax */
  graph: GraphSpec | string;
  /** Rendering options */
  options?: MermaidDiagramOptions;
  /** Called when a node is clicked */
  onNodeClick?: (nodeId: string) => void;
  /** Called when an edge is clicked */
  onEdgeClick?: (source: string, target: string) => void;
  /** Additional CSS classes */
  className?: string;
  /** Enable zoom and pan */
  interactive?: boolean;
  /** Show loading state */
  loading?: boolean;
  /** Error message */
  error?: string | null;
}

export function MermaidGraph({
  graph,
  options = {},
  onNodeClick,
  onEdgeClick,
  className = "",
  interactive = true,
  loading = false,
  error: externalError,
}: MermaidGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(externalError || null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });

  // Initialize Mermaid
  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: options.theme || "default",
      securityLevel: "loose",
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: "basis",
      },
    });
  }, [options.theme]);

  // Render diagram when graph changes
  useEffect(() => {
    const render = async () => {
      if (!containerRef.current) return;

      try {
        // Generate Mermaid syntax if given a GraphSpec
        const mermaidCode =
          typeof graph === "string"
            ? graph
            : generateMermaidDiagram(graph, options);

        // Generate unique ID for this render
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Render to SVG
        const { svg: renderedSvg } = await mermaid.render(id, mermaidCode);
        setSvg(renderedSvg);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to render diagram");
        setSvg("");
      }
    };

    render();
  }, [graph, options]);

  // Handle node clicks
  const handleSvgClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      
      // Find closest node element
      const nodeElement = target.closest("[id^='flowchart-']");
      if (nodeElement && onNodeClick) {
        // Extract node ID from element ID (format: flowchart-nodeId-...)
        const id = nodeElement.id.replace(/^flowchart-/, "").split("-")[0];
        if (id) {
          onNodeClick(id);
          return;
        }
      }

      // Check for edge click
      if (target.tagName === "path" && onEdgeClick) {
        // Edge detection is trickier in Mermaid - would need custom data attributes
        // For now, skip edge clicks in basic implementation
      }
    },
    [onNodeClick, onEdgeClick]
  );

  // Zoom handlers
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!interactive) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setZoom((z) => Math.max(0.1, Math.min(5, z * delta)));
    },
    [interactive]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!interactive) return;
      setIsDragging(true);
      dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    },
    [interactive, pan]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging || !interactive) return;
      setPan({
        x: e.clientX - dragStart.current.x,
        y: e.clientY - dragStart.current.y,
      });
    },
    [isDragging, interactive]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Reset view
  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  if (loading) {
    return (
      <div
        className={`flex items-center justify-center bg-gray-50 rounded-lg ${className}`}
        style={{ minHeight: "200px" }}
      >
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={`flex items-center justify-center bg-red-50 rounded-lg p-4 ${className}`}
        style={{ minHeight: "200px" }}
      >
        <div className="text-center">
          <p className="text-red-600 font-medium">Failed to render diagram</p>
          <p className="text-red-500 text-sm mt-1">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      {/* Controls */}
      {interactive && (
        <div className="absolute top-2 right-2 z-10 flex gap-1 bg-white rounded-lg shadow p-1">
          <button
            onClick={() => setZoom((z) => Math.min(5, z * 1.2))}
            className="p-1.5 hover:bg-gray-100 rounded"
            title="Zoom in"
          >
            <ZoomInIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => setZoom((z) => Math.max(0.1, z * 0.8))}
            className="p-1.5 hover:bg-gray-100 rounded"
            title="Zoom out"
          >
            <ZoomOutIcon className="w-4 h-4" />
          </button>
          <button
            onClick={resetView}
            className="p-1.5 hover:bg-gray-100 rounded"
            title="Reset view"
          >
            <ResetIcon className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Diagram */}
      <div
        ref={containerRef}
        className={`overflow-hidden rounded-lg bg-white ${
          interactive ? "cursor-grab active:cursor-grabbing" : ""
        }`}
        style={{ minHeight: "200px" }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleSvgClick}
      >
        <div
          dangerouslySetInnerHTML={{ __html: svg }}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "center center",
            transition: isDragging ? "none" : "transform 0.1s ease-out",
          }}
          className="flex items-center justify-center"
        />
      </div>
    </div>
  );
}

// --- Icons ---

function ZoomInIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function ZoomOutIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
    </svg>
  );
}

function ResetIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
    </svg>
  );
}
