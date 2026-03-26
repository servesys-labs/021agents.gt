/**
 * Condition Node Component
 * 
 * Visual representation of a conditional branch node in the graph editor.
 * Uses a diamond shape.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";

interface ConditionNodeData {
  label: string;
  config?: {
    condition?: string;
    operator?: string;
  };
}

export function ConditionNode({ data, selected }: NodeProps<ConditionNodeData>) {
  const config = data.config || {};
  
  return (
    <div
      className={`
        min-w-[140px] bg-green-50 border-2 rounded-lg shadow-sm
        ${selected ? "border-green-500 shadow-md" : "border-green-200"}
      `}
    >
      {/* Header */}
      <div className="bg-green-100 px-3 py-2 rounded-t-lg flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-green-500" />
        <span className="text-xs font-semibold text-green-800 uppercase tracking-wide">
          Condition
        </span>
      </div>
      
      {/* Body */}
      <div className="p-3">
        <div className="font-medium text-sm text-gray-800 truncate">
          {data.label}
        </div>
        
        {config.condition && (
          <div className="mt-1 text-xs font-mono text-green-700 bg-green-100 px-2 py-1 rounded">
            {config.condition}
          </div>
        )}
      </div>
      
      {/* Handles - multiple outputs for branches */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-green-500"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="true"
        className="!w-3 !h-3 !bg-green-500"
        style={{ left: "30%" }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="false"
        className="!w-3 !h-3 !bg-red-400"
        style={{ left: "70%" }}
      />
    </div>
  );
}
