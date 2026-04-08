/**
 * Subgraph Node Component
 * 
 * Visual representation of a nested subgraph call in the graph editor.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";

interface SubgraphNodeData {
  label: string;
  config?: {
    subgraphId?: string;
    version?: string;
    inputMapping?: Record<string, string>;
    outputMapping?: Record<string, string>;
  };
}

export function SubgraphNode({ data, selected }: NodeProps<SubgraphNodeData>) {
  const config = data.config || {};
  
  return (
    <div
      className={`
        min-w-[200px] bg-pink-50 border-2 rounded-lg shadow-sm
        ${selected ? "border-pink-500 shadow-md" : "border-pink-200"}
      `}
    >
      {/* Header */}
      <div className="bg-pink-100 px-3 py-2 rounded-t-lg flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-pink-500" />
        <span className="text-xs font-semibold text-pink-800 uppercase tracking-wide">
          Subgraph
        </span>
      </div>
      
      {/* Body */}
      <div className="p-3">
        <div className="font-medium text-sm text-gray-800 truncate">
          {data.label}
        </div>
        
        {config.subgraphId && (
          <div className="mt-1 text-xs font-mono text-pink-600">
            {config.subgraphId}
            {config.version && `@${config.version}`}
          </div>
        )}
        
        {(config.inputMapping || config.outputMapping) && (
          <div className="mt-2 space-y-1">
            {config.inputMapping && (
              <div className="text-xs text-gray-500">
                <span className="text-green-600">→</span> {Object.keys(config.inputMapping).length} inputs
              </div>
            )}
            {config.outputMapping && (
              <div className="text-xs text-gray-500">
                <span className="text-blue-600">←</span> {Object.keys(config.outputMapping).length} outputs
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* Handles */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-pink-500"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-pink-500"
      />
    </div>
  );
}
