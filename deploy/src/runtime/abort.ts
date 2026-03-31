/**
 * Phase 3.3: Abort Controller Hierarchy
 *
 * Parent→child abort propagation with sibling isolation.
 * When a parent aborts, all children abort. When a child aborts (e.g., tool
 * error), siblings are cancelled but the parent turn continues.
 *
 * Uses WeakRef to prevent memory leaks from abandoned child controllers.
 * Inspired by Claude Code's createChildAbortController pattern.
 */

/**
 * Create a child AbortController that aborts when the parent does,
 * but does NOT propagate child abort to parent.
 *
 * Memory-safe: uses WeakRef so abandoned children can be GC'd.
 */
export function createChildAbortController(parent: AbortController): AbortController {
  const child = new AbortController();

  // Fast path: parent already aborted
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason);
    return child;
  }

  // Use WeakRef to avoid preventing child GC
  const weakChild = new WeakRef(child);

  const onParentAbort = () => {
    const c = weakChild.deref();
    if (c && !c.signal.aborted) {
      c.abort(parent.signal.reason);
    }
  };

  parent.signal.addEventListener("abort", onParentAbort, { once: true });

  // Cleanup: remove parent listener when child aborts (prevents handler accumulation)
  child.signal.addEventListener("abort", () => {
    parent.signal.removeEventListener("abort", onParentAbort);
  }, { once: true });

  return child;
}

/**
 * Create a sibling abort controller that cancels all siblings when one fails.
 * Each sibling is a child of the shared parent.
 * When any sibling aborts, all other siblings abort — but parent does NOT.
 */
export function createSiblingGroup(parent: AbortController, count: number): AbortController[] {
  const siblings: AbortController[] = [];
  const sharedSiblingController = createChildAbortController(parent);

  for (let i = 0; i < count; i++) {
    siblings.push(createChildAbortController(sharedSiblingController));
  }

  // When any sibling aborts with an error, abort the shared controller
  // (which cascades to all siblings)
  for (const sib of siblings) {
    sib.signal.addEventListener("abort", () => {
      if (!sharedSiblingController.signal.aborted) {
        sharedSiblingController.abort("sibling_failed");
      }
    }, { once: true });
  }

  return siblings;
}
