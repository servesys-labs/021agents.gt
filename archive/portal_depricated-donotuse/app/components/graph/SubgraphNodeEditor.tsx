/**
 * SubgraphNodeEditor
 * 
 * Modal/editor for configuring a subgraph node within the graph editor.
 */

import { useState, useCallback, useEffect } from "react";
import { SubgraphConfigPanel } from "./SubgraphConfigPanel";
import { MermaidGraph } from "./MermaidGraph";

interface SubgraphNodeEditorProps {
  isOpen: boolean;
  onClose: () => void;
  nodeId: string;
  nodeLabel: string;
  config?: Record<string, unknown>;
  availableSubgraphs?: Array<{
    id: string;
    name: string;
    version: string;
    description?: string;
    inputSchema?: Record<string, string>;
    outputSchema?: Record<string, string>;
  }>;
  parentOutputs?: string[];
  previewGraph?: unknown;
  onSave: (config: Record<string, unknown>) => void;
  onLoadSubgraph?: (id: string, version?: string) => Promise<unknown | null>;
}

export function SubgraphNodeEditor({
  isOpen,
  onClose,
  nodeId,
  nodeLabel,
  config = {},
  availableSubgraphs = [],
  parentOutputs = [],
  previewGraph,
  onSave,
  onLoadSubgraph,
}: SubgraphNodeEditorProps) {
  const [localConfig, setLocalConfig] = useState<Record<string, unknown>>(config);
  const [activeTab, setActiveTab] = useState<"config" | "preview">("config");
  const [isSaving, setIsSaving] = useState(false);

  // Reset local config when modal opens
  useEffect(() => {
    if (isOpen) {
      setLocalConfig(config);
      setActiveTab("config");
    }
  }, [isOpen, config]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      onSave(localConfig);
      onClose();
    } finally {
      setIsSaving(false);
    }
  }, [localConfig, onSave, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-lg font-semibold">Configure Subgraph Node</h2>
            <p className="text-sm text-gray-500">
              {nodeLabel} ({nodeId})
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b">
          <button
            onClick={() => setActiveTab("config")}
            className={`px-6 py-3 text-sm font-medium border-b-2 ${
              activeTab === "config"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            Configuration
          </button>
          <button
            onClick={() => setActiveTab("preview")}
            className={`px-6 py-3 text-sm font-medium border-b-2 ${
              activeTab === "preview"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            Preview
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {activeTab === "config" ? (
            <div className="max-w-xl">
              <SubgraphConfigPanel
                config={{
                  subgraphId: localConfig.subgraphId as string | undefined,
                  version: localConfig.version as string | undefined,
                  inputMapping: (localConfig.inputMapping as Record<string, string>) || {},
                  outputMapping: (localConfig.outputMapping as Record<string, string>) || {},
                }}
                availableSubgraphs={availableSubgraphs}
                parentOutputs={parentOutputs}
                onChange={(newConfig) =>
                  setLocalConfig((prev) => ({ ...prev, ...newConfig }))
                }
                onLoadSubgraph={onLoadSubgraph}
              />
            </div>
          ) : (
            <div>
              <p className="text-sm text-gray-600 mb-4">
                Preview of the selected subgraph structure:
              </p>
              {previewGraph ? (
                <MermaidGraph
                  graph={previewGraph as any}
                  options={{ compact: false }}
                  className="border rounded-lg"
                />
              ) : (
                <div className="text-center py-12 text-gray-500 bg-gray-50 rounded-lg">
                  Select a subgraph in the Configuration tab to see a preview
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !localConfig.subgraphId}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? "Saving..." : "Save Configuration"}
          </button>
        </div>
      </div>
    </div>
  );
}
