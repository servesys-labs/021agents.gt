import { describe, it, expect } from "vitest";
import { parseAgentConfigJson } from "../src/schemas/common";

describe("parseAgentConfigJson", () => {
  it("parses valid JSON string", () => {
    expect(parseAgentConfigJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns {} for invalid JSON string", () => {
    expect(parseAgentConfigJson("{not json")).toEqual({});
  });

  it("returns {} for empty or whitespace string", () => {
    expect(parseAgentConfigJson("")).toEqual({});
    expect(parseAgentConfigJson("   ")).toEqual({});
  });

  it("returns {} for JSON array (not an object config)", () => {
    expect(parseAgentConfigJson("[1,2]")).toEqual({});
  });

  it("passes through plain objects", () => {
    const o = { model: "x" };
    expect(parseAgentConfigJson(o)).toBe(o);
  });

  it("returns {} for null and non-objects", () => {
    expect(parseAgentConfigJson(null)).toEqual({});
    expect(parseAgentConfigJson(42)).toEqual({});
  });
});
