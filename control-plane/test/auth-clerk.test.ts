import { describe, it, expect } from "vitest";
import { deriveDisplayName } from "../src/auth/cf-access";

describe("deriveDisplayName", () => {
  it("uses explicit name when present", () => {
    expect(deriveDisplayName({ name: "Jane Doe", email: "jane@example.com" })).toBe("Jane Doe");
  });

  it("falls back to given/family name", () => {
    expect(deriveDisplayName({ given_name: "Jane", family_name: "Doe" })).toBe("Jane Doe");
  });

  it("falls back to email prefix", () => {
    expect(deriveDisplayName({ email: "jane.doe@example.com" })).toBe("jane doe");
  });
});
