/**
 * Tool Node Component
 * 
 * Visual representation of a tool call node in the graph editor.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";

interface ToolNodeData {
  label: string;
  config?: {
    toolName?: string;
    timeout?: number;
    retries?: number;
  };
}

export function ToolNode({ data, selected }: NodeProps<ToolNodeData>) {
  const config = data.config || {};
  
  return (
    <div
      className={`
        min-w-[180px] bg-purple-50 border-2 rounded-lg shadow-sm
        ${selected ? "border-purple-500 shadow-md" : "border-purple-200"}
      `}
    >
      {/* Header */}
      <div className="bg-purple-100 px-3 py-2 rounded-t-lg flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-purple-500" />
        <span className="text-xs font-semibold text-purple-800 uppercase tracking-wide">
          Tool
        </span>
      </div>
      
      {/* Body */}
      <div className="p-3">
        <div className="font-medium text-sm text-gray-800 truncate">
          {data.label}
        </div>
        
        {config.toolName && (
          <div className="mt-1 text-xs font-mono text-purple-600">
            {config.toolName}
          </div>
        )}
        
        {(config.timeout || config.retries) && (
          <div className="mt-2 flex gap-2 text-xs text-gray-500">
            {config.timeout && (
              <span className="bg-purple-100 px-1.5 py-0.5 rounded">
                ⏱ {config.timeout}s
              </span>
            )}
            {config.retries && (
              <span className="bg-purple-100 px-1.5 py-0.5 rounded">
                ↻ {config.retries}
              </span>
            )}
          </div>
        )}
      </div>
      
      {/* Handles */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-purple-500"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-purple-500"
      />
    </div>
  );
}
