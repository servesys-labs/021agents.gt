/**
 * Loop Node Component
 * 
 * Visual representation of a loop/repeat node in the graph editor.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";

interface LoopNodeData {
  label: string;
  config?: {
    maxIterations?: number;
    exitCondition?: string;
  };
}

export function LoopNode({ data, selected }: NodeProps<LoopNodeData>) {
  const config = data.config || {};
  
  return (
    <div
      className={`
        min-w-[160px] bg-yellow-50 border-2 rounded-lg shadow-sm
        ${selected ? "border-yellow-500 shadow-md" : "border-yellow-200"}
      `}
    >
      {/* Header */}
      <div className="bg-yellow-100 px-3 py-2 rounded-t-lg flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-yellow-500" />
        <span className="text-xs font-semibold text-yellow-800 uppercase tracking-wide">
          Loop
        </span>
      </div>
      
      {/* Body */}
      <div className="p-3">
        <div className="font-medium text-sm text-gray-800 truncate">
          {data.label}
        </div>
        
        {config.maxIterations && (
          <div className="mt-2 flex gap-2 text-xs text-gray-500">
            <span className="bg-yellow-100 px-1.5 py-0.5 rounded">
              ↻ max {config.maxIterations}
            </span>
          </div>
        )}
        
        {config.exitCondition && (
          <div className="mt-1 text-xs text-yellow-700">
            Exit: {config.exitCondition}
          </div>
        )}
      </div>
      
      {/* Handles */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-yellow-500"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="body"
        className="!w-3 !h-3 !bg-yellow-500"
        style={{ left: "30%" }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="exit"
        className="!w-3 !h-3 !bg-green-400"
        style={{ left: "70%" }}
      />
    </div>
  );
}
