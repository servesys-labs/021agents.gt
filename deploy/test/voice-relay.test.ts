/**
 * Unit tests for the voice-relay module: mulaw decoding, WAV generation,
 * TwiML generation, and XML escaping.
 */
import { describe, it, expect } from "vitest";

import {
  mulawDecode,
  mulawToWav,
  generateMediaStreamTwiML,
  escapeXml,
} from "../src/runtime/voice-relay";

// ── mulawDecode ──────────────────────────────────────────────────────────────

describe("mulawDecode", () => {
  it("decodes 0xFF (near-silence) to a small magnitude value", () => {
    // 0xFF is the mulaw encoding closest to silence on the negative side
    // Standard mulaw: 0xFF → small negative value (magnitude ~132 with bias)
    const sample = mulawDecode(0xFF);
    expect(Math.abs(sample)).toBeLessThan(200);
  });

  it("decodes 0x00 to a large negative value", () => {
    const sample = mulawDecode(0x00);
    expect(sample).toBeLessThan(-8000);
  });

  it("decodes 0x80 to a large positive value", () => {
    const sample = mulawDecode(0x80);
    expect(sample).toBeGreaterThan(8000);
  });

  it("returns values within 16-bit signed range", () => {
    for (let b = 0; b <= 255; b++) {
      const sample = mulawDecode(b);
      expect(sample).toBeGreaterThanOrEqual(-32768);
      expect(sample).toBeLessThanOrEqual(32767);
    }
  });

  it("treats high bit (0x80 vs 0x00) as sign flip", () => {
    // 0x00 and 0x80 should differ in sign
    const neg = mulawDecode(0x00);
    const pos = mulawDecode(0x80);
    expect(neg).toBeLessThan(0);
    expect(pos).toBeGreaterThan(0);
    // They should be roughly symmetric (same magnitude, opposite sign)
    expect(Math.abs(Math.abs(neg) - Math.abs(pos))).toBeLessThan(200);
  });
});

// ── mulawToWav ───────────────────────────────────────────────────────────────

describe("mulawToWav", () => {
  const mulaw100 = new Uint8Array(100).fill(0xFF); // 100 bytes of silence
  const wav = mulawToWav(mulaw100, 8000);

  it("starts with RIFF magic bytes", () => {
    const riff = String.fromCharCode(wav[0], wav[1], wav[2], wav[3]);
    expect(riff).toBe("RIFF");
  });

  it("has WAVE format identifier at bytes 8-11", () => {
    const wave = String.fromCharCode(wav[8], wav[9], wav[10], wav[11]);
    expect(wave).toBe("WAVE");
  });

  it("has 'fmt ' chunk at bytes 12-15", () => {
    const fmt = String.fromCharCode(wav[12], wav[13], wav[14], wav[15]);
    expect(fmt).toBe("fmt ");
  });

  it("encodes sample rate as 8000 in the header", () => {
    // Sample rate is at byte offset 24, little-endian uint32
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const sampleRate = view.getUint32(24, true);
    expect(sampleRate).toBe(8000);
  });

  it("encodes channels = 1 (mono)", () => {
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const channels = view.getUint16(22, true);
    expect(channels).toBe(1);
  });

  it("encodes bits per sample = 16", () => {
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const bitsPerSample = view.getUint16(34, true);
    expect(bitsPerSample).toBe(16);
  });

  it("encodes PCM format (format code 1)", () => {
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const audioFormat = view.getUint16(20, true);
    expect(audioFormat).toBe(1);
  });

  it("has total size = 44 header + 2*mulaw.length (PCM 16-bit)", () => {
    // 100 mulaw samples → 100 PCM int16 samples → 200 bytes of PCM data
    expect(wav.byteLength).toBe(44 + 100 * 2);
  });

  it("has correct RIFF chunk size", () => {
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const riffSize = view.getUint32(4, true);
    // RIFF size = total file size - 8 (for "RIFF" + size field itself)
    expect(riffSize).toBe(wav.byteLength - 8);
  });

  it("has correct data chunk size", () => {
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const dataSize = view.getUint32(40, true);
    expect(dataSize).toBe(100 * 2); // 100 samples * 2 bytes each
  });

  it("works with different sample rates", () => {
    const wav16k = mulawToWav(new Uint8Array(50), 16000);
    const view = new DataView(wav16k.buffer, wav16k.byteOffset, wav16k.byteLength);
    expect(view.getUint32(24, true)).toBe(16000);
    // Byte rate should be sampleRate * 2 (16-bit mono)
    expect(view.getUint32(28, true)).toBe(32000);
  });
});

// ── generateMediaStreamTwiML ─────────────────────────────────────────────────

describe("generateMediaStreamTwiML", () => {
  it("generates valid XML with Response/Connect/Stream structure", () => {
    const twiml = generateMediaStreamTwiML("wss://example.com/stream");
    expect(twiml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(twiml).toContain("<Response>");
    expect(twiml).toContain("<Connect>");
    expect(twiml).toContain("<Stream");
    expect(twiml).toContain("</Connect>");
    expect(twiml).toContain("</Response>");
  });

  it("inserts the WebSocket URL correctly", () => {
    const url = "wss://my-app.example.com/voice/ws";
    const twiml = generateMediaStreamTwiML(url);
    expect(twiml).toContain(`url="${url}"`);
  });

  it("includes <Say> element when greeting is provided", () => {
    const twiml = generateMediaStreamTwiML("wss://example.com/stream", "Hello there!");
    expect(twiml).toContain("<Say>Hello there!</Say>");
  });

  it("omits <Say> element when greeting is empty string", () => {
    const twiml = generateMediaStreamTwiML("wss://example.com/stream", "");
    expect(twiml).not.toContain("<Say>");
  });

  it("omits <Say> element when greeting is undefined", () => {
    const twiml = generateMediaStreamTwiML("wss://example.com/stream");
    expect(twiml).not.toContain("<Say>");
  });

  it("XML-escapes special characters in the greeting", () => {
    const twiml = generateMediaStreamTwiML(
      "wss://example.com/stream",
      'Hello & welcome to <OneShots> "AI"'
    );
    expect(twiml).toContain("&amp;");
    expect(twiml).toContain("&lt;OneShots&gt;");
    expect(twiml).toContain("&quot;AI&quot;");
    // Should NOT contain raw special chars in the greeting
    expect(twiml).not.toMatch(/<Say>.*[&](?!amp;|lt;|gt;|quot;).*<\/Say>/);
  });

  it("XML-escapes special characters in the URL", () => {
    const twiml = generateMediaStreamTwiML("wss://example.com/stream?a=1&b=2");
    expect(twiml).toContain("a=1&amp;b=2");
  });
});

// ── escapeXml ────────────────────────────────────────────────────────────────

describe("escapeXml", () => {
  it("escapes ampersand", () => {
    expect(escapeXml("A & B")).toBe("A &amp; B");
  });

  it("escapes less-than", () => {
    expect(escapeXml("a < b")).toBe("a &lt; b");
  });

  it("escapes greater-than", () => {
    expect(escapeXml("a > b")).toBe("a &gt; b");
  });

  it("escapes double quotes", () => {
    expect(escapeXml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("passes through normal text unchanged", () => {
    expect(escapeXml("Hello world 123")).toBe("Hello world 123");
  });

  it("handles empty string", () => {
    expect(escapeXml("")).toBe("");
  });

  it("escapes multiple special characters in one string", () => {
    expect(escapeXml('<div class="x">&</div>')).toBe(
      "&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;"
    );
  });
});
