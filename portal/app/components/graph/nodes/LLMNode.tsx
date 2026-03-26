/**
 * LLM Node Component
 * 
 * Visual representation of an LLM call node in the graph editor.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";

interface LLMNodeData {
  label: string;
  config?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
  };
}

export function LLMNode({ data, selected }: NodeProps<LLMNodeData>) {
  const config = data.config || {};
  
  return (
    <div
      className={`
        min-w-[180px] bg-blue-50 border-2 rounded-lg shadow-sm
        ${selected ? "border-blue-500 shadow-md" : "border-blue-200"}
      `}
    >
      {/* Header */}
      <div className="bg-blue-100 px-3 py-2 rounded-t-lg flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-blue-500" />
        <span className="text-xs font-semibold text-blue-800 uppercase tracking-wide">
          LLM
        </span>
      </div>
      
      {/* Body */}
      <div className="p-3">
        <div className="font-medium text-sm text-gray-800 truncate">
          {data.label}
        </div>
        
        {config.model && (
          <div className="mt-1 text-xs text-gray-500">
            {config.model}
          </div>
        )}
        
        {(config.temperature !== undefined || config.maxTokens) && (
          <div className="mt-2 flex gap-2 text-xs text-gray-500">
            {config.temperature !== undefined && (
              <span className="bg-blue-100 px-1.5 py-0.5 rounded">
                T: {config.temperature}
              </span>
            )}
            {config.maxTokens && (
              <span className="bg-blue-100 px-1.5 py-0.5 rounded">
                {config.maxTokens} tokens
              </span>
            )}
          </div>
        )}
      </div>
      
      {/* Handles */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-blue-500"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-blue-500"
      />
    </div>
  );
}
