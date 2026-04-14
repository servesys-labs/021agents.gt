/**
 * Shared drag context for canvas tool DnD.
 *
 * Why a module-level ref and not a Svelte store: the HTML5 drag API only
 * exposes the drag payload during `drop`, not during `dragover`. To show a
 * drop-target preview *while* dragging, we need to know what's being dragged
 * at the moment dragover fires on the canvas. The ToolPalette stashes the
 * tool here on dragstart; the AgentCanvas reads it on dragover.
 *
 * This is a normal JS module, not a reactive store — the consumer
 * (AgentCanvas) pulls the value once at drag start and copies it into its
 * own local $state for reactivity. Keeps the DnD plumbing off the reactive
 * graph so we don't trigger renders on every dragover event.
 */

export interface DragTool {
  id: string;
  name: string;
}

let current: DragTool | null = null;

export function setCurrentDragTool(tool: DragTool | null): void {
  current = tool;
}

export function getCurrentDragTool(): DragTool | null {
  return current;
}
