/**
 * SubgraphConfigPanel
 * 
 * Configuration UI for subgraph nodes - allows selecting and configuring
 * nested graph references.
 */

import { useState, useEffect } from "react";

interface SubgraphDefinition {
  id: string;
  name: string;
  version: string;
  description?: string;
  inputSchema?: Record<string, string>;
  outputSchema?: Record<string, string>;
}

interface SubgraphConfigPanelProps {
  config?: {
    subgraphId?: string;
    version?: string;
    inputMapping?: Record<string, string>;
    outputMapping?: Record<string, string>;
  };
  availableSubgraphs?: SubgraphDefinition[];
  parentOutputs?: string[];
  onChange: (config: Record<string, unknown>) => void;
  onLoadSubgraph?: (id: string, version?: string) => Promise<SubgraphDefinition | null>;
}

export function SubgraphConfigPanel({
  config = {},
  availableSubgraphs = [],
  parentOutputs = [],
  onChange,
  onLoadSubgraph,
}: SubgraphConfigPanelProps) {
  const [selectedSubgraph, setSelectedSubgraph] = useState<SubgraphDefinition | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [inputMapping, setInputMapping] = useState<Record<string, string>>(
    config.inputMapping || {}
  );
  const [outputMapping, setOutputMapping] = useState<Record<string, string>>(
    config.outputMapping || {}
  );

  // Load subgraph details when ID changes
  useEffect(() => {
    if (!config.subgraphId) return;
    
    const load = async () => {
      setIsLoading(true);
      try {
        // First check available list
        let def = availableSubgraphs.find(
          (s) => s.id === config.subgraphId && (!config.version || s.version === config.version)
        );
        
        // If not found, try to load via callback
        if (!def && onLoadSubgraph) {
          def = await onLoadSubgraph(config.subgraphId, config.version);
        }
        
        setSelectedSubgraph(def || null);
      } finally {
        setIsLoading(false);
      }
    };
    
    load();
  }, [config.subgraphId, config.version, availableSubgraphs, onLoadSubgraph]);

  // Update parent when mappings change
  useEffect(() => {
    onChange({
      ...config,
      inputMapping,
      outputMapping,
    });
  }, [inputMapping, outputMapping]);

  const handleSubgraphSelect = (id: string, version?: string) => {
    onChange({
      ...config,
      subgraphId: id,
      version,
      // Reset mappings when subgraph changes
      inputMapping: {},
      outputMapping: {},
    });
    setInputMapping({});
    setOutputMapping({});
  };

  return (
    <div className="space-y-4">
      {/* Subgraph Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Subgraph
        </label>
        <select
          value={config.subgraphId || ""}
          onChange={(e) => handleSubgraphSelect(e.target.value)}
          className="w-full border rounded px-3 py-2 text-sm"
        >
          <option value="">Select a subgraph...</option>
          {availableSubgraphs.map((sg) => (
            <option key={`${sg.id}@${sg.version}`} value={sg.id}>
              {sg.name} @ {sg.version}
            </option>
          ))}
        </select>
        {isLoading && (
          <div className="text-xs text-gray-500 mt-1">Loading...</div>
        )}
      </div>

      {/* Selected Subgraph Info */}
      {selectedSubgraph && (
        <div className="bg-gray-50 rounded p-3 text-sm">
          <div className="font-medium">{selectedSubgraph.name}</div>
          {selectedSubgraph.description && (
            <div className="text-gray-600 mt-1">{selectedSubgraph.description}</div>
          )}
        </div>
      )}

      {/* Input Mapping */}
      {selectedSubgraph?.inputSchema && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Input Mapping
          </label>
          <div className="space-y-2">
            {Object.entries(selectedSubgraph.inputSchema).map(([key, type]) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-sm font-mono bg-gray-100 px-2 py-1 rounded">
                  {key}: {type}
                </span>
                <span className="text-gray-500">←</span>
                <select
                  value={inputMapping[key] || ""}
                  onChange={(e) =>
                    setInputMapping((m) => ({
                      ...m,
                      [key]: e.target.value,
                    }))
                  }
                  className="flex-1 border rounded px-2 py-1 text-sm"
                >
                  <option value="">Select source...</option>
                  {parentOutputs.map((out) => (
                    <option key={out} value={out}>
                      {out}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Output Mapping */}
      {selectedSubgraph?.outputSchema && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Output Mapping
          </label>
          <div className="space-y-2">
            {Object.entries(selectedSubgraph.outputSchema).map(([key, type]) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-sm font-mono bg-gray-100 px-2 py-1 rounded">
                  {key}: {type}
                </span>
                <span className="text-gray-500">→</span>
                <input
                  type="text"
                  value={outputMapping[key] || key}
                  onChange={(e) =>
                    setOutputMapping((m) => ({
                      ...m,
                      [key]: e.target.value,
                    }))
                  }
                  placeholder="Output alias"
                  className="flex-1 border rounded px-2 py-1 text-sm"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Validation */}
      {selectedSubgraph && (
        <div className="text-xs">
          {Object.keys(selectedSubgraph.inputSchema || {}).every(
            (k) => inputMapping[k]
          ) ? (
            <span className="text-green-600">✓ All inputs mapped</span>
          ) : (
            <span className="text-yellow-600">
              ⚠ {Object.keys(selectedSubgraph.inputSchema || {}).filter(
                (k) => !inputMapping[k]
              ).length} inputs unmapped
            </span>
          )}
        </div>
      )}
    </div>
  );
}
