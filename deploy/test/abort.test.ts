/**
 * Tests for deploy/src/runtime/abort.ts
 * Phase 3.3: Abort controller hierarchy
 */
import { describe, it, expect } from "vitest";
import { createChildAbortController, createSiblingGroup } from "../src/runtime/abort";

describe("createChildAbortController", () => {
  it("child aborts when parent aborts", () => {
    const parent = new AbortController();
    const child = createChildAbortController(parent);

    expect(child.signal.aborted).toBe(false);
    parent.abort("test reason");
    expect(child.signal.aborted).toBe(true);
  });

  it("parent does NOT abort when child aborts", () => {
    const parent = new AbortController();
    const child = createChildAbortController(parent);

    child.abort("child reason");
    expect(child.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  it("creates already-aborted child if parent is already aborted", () => {
    const parent = new AbortController();
    parent.abort("already");
    const child = createChildAbortController(parent);
    expect(child.signal.aborted).toBe(true);
  });

  it("multiple children all abort when parent aborts", () => {
    const parent = new AbortController();
    const c1 = createChildAbortController(parent);
    const c2 = createChildAbortController(parent);
    const c3 = createChildAbortController(parent);

    parent.abort();
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
    expect(c3.signal.aborted).toBe(true);
  });

  it("aborting one child does not affect siblings", () => {
    const parent = new AbortController();
    const c1 = createChildAbortController(parent);
    const c2 = createChildAbortController(parent);

    c1.abort();
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(false);
    expect(parent.signal.aborted).toBe(false);
  });
});

describe("createSiblingGroup", () => {
  it("creates the requested number of controllers", () => {
    const parent = new AbortController();
    const siblings = createSiblingGroup(parent, 5);
    expect(siblings.length).toBe(5);
    expect(siblings.every(s => !s.signal.aborted)).toBe(true);
  });

  it("aborting one sibling aborts all others", () => {
    const parent = new AbortController();
    const siblings = createSiblingGroup(parent, 3);

    siblings[0].abort("failed");
    // Give microtask a chance to propagate
    expect(siblings[0].signal.aborted).toBe(true);
    // Siblings should also be aborted via shared controller
    expect(siblings[1].signal.aborted).toBe(true);
    expect(siblings[2].signal.aborted).toBe(true);
  });

  it("parent abort cascades to all siblings", () => {
    const parent = new AbortController();
    const siblings = createSiblingGroup(parent, 3);

    parent.abort("parent done");
    expect(siblings.every(s => s.signal.aborted)).toBe(true);
  });

  it("sibling abort does NOT propagate to parent", () => {
    const parent = new AbortController();
    const siblings = createSiblingGroup(parent, 2);

    siblings[0].abort();
    expect(parent.signal.aborted).toBe(false);
  });

  it("handles empty group", () => {
    const parent = new AbortController();
    const siblings = createSiblingGroup(parent, 0);
    expect(siblings.length).toBe(0);
  });
});
