import { describe, it, expect } from "vitest";
import { uint8ArrayToBase64 } from "../src/runtime/binary-enc";

describe("uint8ArrayToBase64", () => {
  it("round-trips small payload", () => {
    const raw = new Uint8Array([0, 1, 2, 255, 128]);
    const b64 = uint8ArrayToBase64(raw);
    expect(atob(b64).length).toBe(raw.length);
  });

  it("handles multi-chunk sizes", () => {
    const raw = new Uint8Array(20_000);
    for (let i = 0; i < raw.length; i++) raw[i] = i % 256;
    const b64 = uint8ArrayToBase64(raw);
    expect(b64.length).toBeGreaterThan(1000);
  });
});
