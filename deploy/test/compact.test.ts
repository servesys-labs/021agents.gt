/**
 * Tests for deploy/src/runtime/compact.ts
 * Phase 2.4: Context compression
 */
import { describe, it, expect } from "vitest";
import { shouldCompact, compactMessages } from "../src/runtime/compact";

describe("shouldCompact", () => {
  it("returns false for short conversations", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    expect(shouldCompact(messages)).toBe(false);
  });

  it("returns true when messages exceed 85% of context window", () => {
    // Create messages that total ~110K tokens (at 4 chars/token = ~440K chars)
    const messages = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(2200), // ~550 tokens each, 200 msgs = ~110K tokens
    }));
    expect(shouldCompact(messages, 128_000)).toBe(true);
  });

  it("returns false when below threshold", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "Short message",
    }));
    expect(shouldCompact(messages, 128_000)).toBe(false);
  });

  it("respects custom model token limit", () => {
    const messages = Array.from({ length: 50 }, () => ({
      role: "user",
      content: "x".repeat(400), // ~100 tokens each = 5K total
    }));
    // Small context window: 5K tokens, 85% = 4250
    expect(shouldCompact(messages, 5000)).toBe(true);
  });
});

describe("compactMessages", () => {
  it("preserves short conversations unchanged", async () => {
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ];
    const result = await compactMessages(messages, 6);
    expect(result).toEqual(messages);
  });

  it("preserves system messages in compacted output", async () => {
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "system", content: "Behavioral rules" },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
      })),
    ];
    const result = await compactMessages(messages, 4);
    // Should have 2 system + 1 summary + 4 recent = 7
    expect(result.filter(m => m.role === "system").length).toBe(2);
    expect(result.length).toBeLessThan(messages.length);
  });

  it("keeps the last N messages intact", async () => {
    const messages = [
      { role: "system", content: "System" },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Msg-${i}`,
      })),
    ];
    const result = await compactMessages(messages, 4);
    const nonSystem = result.filter(m => m.role !== "system");
    // Last 4 should be intact (the recent ones)
    const lastFour = nonSystem.slice(-4);
    expect(lastFour.some(m => m.content.includes("Msg-19"))).toBe(true);
    expect(lastFour.some(m => m.content.includes("Msg-18"))).toBe(true);
  });

  it("includes conversation summary marker", async () => {
    const messages = [
      { role: "system", content: "System" },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Msg-${i}`,
      })),
    ];
    const result = await compactMessages(messages, 4);
    const summary = result.find(m => m.content.includes("Conversation summary"));
    expect(summary).toBeDefined();
  });
});
