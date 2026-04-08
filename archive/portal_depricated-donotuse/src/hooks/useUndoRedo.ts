import { useCallback, useRef } from "react";
import type { Node } from "@xyflow/react";

/**
 * Lightweight undo/redo hook that tracks node position snapshots.
 * Each snapshot stores { id, x, y } for every node.
 * Max history depth prevents memory bloat.
 */

type PositionSnapshot = { id: string; x: number; y: number }[];

const MAX_HISTORY = 50;

export function useUndoRedo() {
  const past = useRef<PositionSnapshot[]>([]);
  const future = useRef<PositionSnapshot[]>([]);

  /** Take a snapshot of current node positions (call before a drag starts) */
  const takeSnapshot = useCallback((nodes: Node[]) => {
    const snap: PositionSnapshot = nodes.map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
    }));
    past.current = [...past.current.slice(-(MAX_HISTORY - 1)), snap];
    // Any new action clears the redo stack
    future.current = [];
  }, []);

  /** Undo: restore the last snapshot, push current state to future */
  const undo = useCallback(
    (
      currentNodes: Node[],
      setNodes: React.Dispatch<React.SetStateAction<Node[]>>,
    ) => {
      if (past.current.length === 0) return;

      // Save current state to future
      const currentSnap: PositionSnapshot = currentNodes.map((n) => ({
        id: n.id,
        x: n.position.x,
        y: n.position.y,
      }));
      future.current = [...future.current, currentSnap];

      // Pop last snapshot from past
      const prevSnap = past.current[past.current.length - 1];
      past.current = past.current.slice(0, -1);

      // Apply positions
      setNodes((nds) =>
        nds.map((n) => {
          const saved = prevSnap.find((s) => s.id === n.id);
          if (saved) {
            return { ...n, position: { x: saved.x, y: saved.y } };
          }
          return n;
        }),
      );
    },
    [],
  );

  /** Redo: restore the next snapshot, push current state to past */
  const redo = useCallback(
    (
      currentNodes: Node[],
      setNodes: React.Dispatch<React.SetStateAction<Node[]>>,
    ) => {
      if (future.current.length === 0) return;

      // Save current state to past
      const currentSnap: PositionSnapshot = currentNodes.map((n) => ({
        id: n.id,
        x: n.position.x,
        y: n.position.y,
      }));
      past.current = [...past.current, currentSnap];

      // Pop next snapshot from future
      const nextSnap = future.current[future.current.length - 1];
      future.current = future.current.slice(0, -1);

      // Apply positions
      setNodes((nds) =>
        nds.map((n) => {
          const saved = nextSnap.find((s) => s.id === n.id);
          if (saved) {
            return { ...n, position: { x: saved.x, y: saved.y } };
          }
          return n;
        }),
      );
    },
    [],
  );

  const canUndo = past.current.length > 0;
  const canRedo = future.current.length > 0;

  return { takeSnapshot, undo, redo, canUndo, canRedo };
}
