import { describe, expect, it } from "vitest";

import { hasAuthToken } from "./auth";

describe("hasAuthToken", () => {
  it("returns true when token exists", () => {
    const storage = { getItem: () => "abc123" };
    expect(hasAuthToken(storage)).toBe(true);
  });

  it("returns false for empty token", () => {
    const storage = { getItem: () => "   " };
    expect(hasAuthToken(storage)).toBe(false);
  });
});
