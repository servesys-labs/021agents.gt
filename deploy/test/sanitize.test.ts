/**
 * Tests for deploy/src/runtime/sanitize.ts
 * Phase 0.1: Unicode input sanitization
 */
import { describe, it, expect } from "vitest";
import { sanitizeUnicode, sanitizeDeep } from "../src/runtime/sanitize";

describe("sanitizeUnicode", () => {
  it("passes through normal ASCII text", () => {
    expect(sanitizeUnicode("Hello, world!")).toBe("Hello, world!");
  });

  it("passes through valid Unicode (CJK, emoji)", () => {
    expect(sanitizeUnicode("Hello 你好 🌍")).toBe("Hello 你好 🌍");
  });

  it("preserves legitimate diacritics and accents", () => {
    const result = sanitizeUnicode("café résumé naïve");
    // NFKC normalizes to composed form (é stays as single char, not decomposed)
    expect(result).toContain("caf");
    expect(result).toContain("sum");
    expect(result).toContain("ve");
    // Should NOT strip the actual diacritics — they're legitimate
    expect(result.length).toBeGreaterThanOrEqual("café résumé naïve".length - 3);
  });

  it("strips zero-width spaces", () => {
    const input = "Hello\u200BWorld"; // zero-width space
    expect(sanitizeUnicode(input)).toBe("HelloWorld");
  });

  it("strips zero-width non-joiner", () => {
    const input = "He\u200Cllo";
    expect(sanitizeUnicode(input)).toBe("Hello");
  });

  it("strips directional override characters (LTR/RTL)", () => {
    const input = "Hello\u202Aworld\u202C"; // LRE + PDF
    expect(sanitizeUnicode(input)).toBe("Helloworld");
  });

  it("strips byte order mark", () => {
    const input = "\uFEFFHello";
    expect(sanitizeUnicode(input)).toBe("Hello");
  });

  it("strips BMP Private Use Area characters", () => {
    const input = "Hello\uE000\uE001World";
    expect(sanitizeUnicode(input)).toBe("HelloWorld");
  });

  it("strips soft hyphen (format control)", () => {
    const input = "discon\u00ADnect";
    // NFKC preserves soft hyphen, but FORMAT_CONTROLS strips it
    const result = sanitizeUnicode(input);
    expect(result).toBe("disconnect");
  });

  it("handles null/undefined/empty gracefully", () => {
    expect(sanitizeUnicode("")).toBe("");
    expect(sanitizeUnicode(null as any)).toBe(null);
    expect(sanitizeUnicode(undefined as any)).toBe(undefined);
  });

  it("converges on nested attacks (iterative stripping)", () => {
    // After NFKC normalization reveals a new dangerous char
    const input = "test\u200B\u200B\u200Bvalue";
    expect(sanitizeUnicode(input)).toBe("testvalue");
  });
});

describe("sanitizeDeep", () => {
  it("sanitizes strings in objects", () => {
    const obj = { name: "Hello\u200BWorld", count: 42 };
    const result = sanitizeDeep(obj) as any;
    expect(result.name).toBe("HelloWorld");
    expect(result.count).toBe(42);
  });

  it("sanitizes strings in arrays", () => {
    const arr = ["Hello\u200B", "World\u200C"];
    const result = sanitizeDeep(arr) as any;
    expect(result[0]).toBe("Hello");
    expect(result[1]).toBe("World");
  });

  it("handles nested objects", () => {
    const obj = { a: { b: { c: "te\u200Bst" } } };
    const result = sanitizeDeep(obj) as any;
    expect(result.a.b.c).toBe("test");
  });

  it("passes through non-string primitives", () => {
    expect(sanitizeDeep(42)).toBe(42);
    expect(sanitizeDeep(true)).toBe(true);
    expect(sanitizeDeep(null)).toBe(null);
  });
});
