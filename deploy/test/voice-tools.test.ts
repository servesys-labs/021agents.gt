/**
 * Tests for TTS/STT tool routing logic.
 *
 * Mocks fetch() globally to verify correct URL routing without making
 * real HTTP calls. Each test verifies that the right endpoint is called
 * based on style/provider arguments.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock heavy dependencies before importing tools ───────────────────────────

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(() => ({
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    writeFile: vi.fn(),
  })),
}));

vi.mock("postgres", () => ({
  default: () => {
    const tag = async (..._args: any[]) => [{ id: 1 }];
    tag.begin = async (fn: any) => fn(tag);
    return tag;
  },
}));

vi.mock("../src/runtime/ssrf", () => ({
  validateUrl: vi.fn(() => ({ allowed: true })),
}));

vi.mock("../src/runtime/scratch", () => ({
  scratchWrite: vi.fn(),
  scratchRead: vi.fn(),
  scratchList: vi.fn(),
}));

vi.mock("../src/runtime/result-storage", () => ({
  retrieveToolResult: vi.fn(),
  cleanupSessionResults: vi.fn(),
}));

vi.mock("../src/runtime/mailbox", () => ({
  writeToMailbox: vi.fn(),
}));

vi.mock("../src/runtime/errors", () => ({
  ToolError: class ToolError extends Error {},
  CircuitBreakerError: class CircuitBreakerError extends Error {
    userMessage: string;
    constructor(name: string) {
      super(name);
      this.userMessage = `Circuit breaker open for ${name}`;
    }
  },
  classifyFetchError: vi.fn(() => "transient"),
}));

vi.mock("../src/runtime/abort", () => ({
  createChildAbortController: vi.fn(() => new AbortController()),
  createSiblingGroup: vi.fn((parent: AbortController, n: number) =>
    Array.from({ length: n }, () => new AbortController())
  ),
}));

vi.mock("../src/runtime/parse-json-column", () => ({
  parseJsonColumn: vi.fn((v: any) => v),
}));

vi.mock("../src/runtime/binary-enc", () => ({
  uint8ArrayToBase64: vi.fn(() => "base64data"),
}));

import { textToSpeech, speechToText } from "../src/runtime/tools";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Fake audio WAV data (minimum valid bytes) */
const FAKE_AUDIO = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x24, 0x00, 0x00, 0x00, // chunk size
  0x57, 0x41, 0x56, 0x45, // WAVE
]);

function createMockEnv(overrides: Record<string, any> = {}) {
  return {
    AI: { run: vi.fn(async () => FAKE_AUDIO) },
    STORAGE: { put: vi.fn(async () => {}) },
    SERVICE_TOKEN: "test-token-123",
    GROQ_API_KEY: "",
    HYPERDRIVE: {},
    VECTORIZE: {},
    SANDBOX: {},
    LOADER: {},
    TELEMETRY_QUEUE: {},
    BROWSER: {},
    DEFAULT_PROVIDER: "anthropic",
    DEFAULT_MODEL: "claude-sonnet-4-20250514",
    ...overrides,
  } as any;
}

let capturedFetchCalls: { url: string; init?: RequestInit }[] = [];

function mockFetchSuccess(contentType = "audio/wav") {
  capturedFetchCalls = [];
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    capturedFetchCalls.push({ url: urlStr, init });
    return new Response(FAKE_AUDIO, {
      status: 200,
      headers: { "Content-Type": contentType },
    });
  }) as any;
}

function mockFetchFailure(status = 500) {
  capturedFetchCalls = [];
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    capturedFetchCalls.push({ url: urlStr, init });
    return new Response("error", { status });
  }) as any;
}

function mockFetchSequence(responses: Array<{ status: number; body?: any }>) {
  capturedFetchCalls = [];
  let callIndex = 0;
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    capturedFetchCalls.push({ url: urlStr, init });
    const resp = responses[callIndex] || responses[responses.length - 1];
    callIndex++;
    if (resp.status >= 400) {
      return new Response("error", { status: resp.status });
    }
    const body = resp.body ?? FAKE_AUDIO;
    return new Response(body, {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
}

// ── TTS Routing Tests ────────────────────────────────────────────────────────

describe("textToSpeech routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedFetchCalls = [];
  });

  it('style="fast" (default) calls tts.oneshots.co', async () => {
    mockFetchSuccess();
    const env = createMockEnv();
    await textToSpeech(env, { text: "Hello world", style: "fast" });

    const ttsCall = capturedFetchCalls.find(c => c.url.includes("tts.oneshots.co"));
    expect(ttsCall).toBeDefined();
    expect(ttsCall!.url).toBe("https://tts.oneshots.co/v1/audio/speech");
  });

  it("default style (no style arg) calls tts.oneshots.co", async () => {
    mockFetchSuccess();
    const env = createMockEnv();
    await textToSpeech(env, { text: "Hello world" });

    const ttsCall = capturedFetchCalls.find(c => c.url.includes("tts.oneshots.co"));
    expect(ttsCall).toBeDefined();
    expect(ttsCall!.url).toBe("https://tts.oneshots.co/v1/audio/speech");
  });

  it('style="clone" with reference_audio_url calls tts-clone.oneshots.co', async () => {
    mockFetchSuccess();
    const env = createMockEnv();
    await textToSpeech(env, {
      text: "Hello clone",
      style: "clone",
      reference_audio_url: "https://example.com/ref.wav",
    });

    // First fetch: download reference audio, second: clone endpoint
    const cloneCall = capturedFetchCalls.find(c =>
      c.url.includes("tts-clone.oneshots.co")
    );
    expect(cloneCall).toBeDefined();
    expect(cloneCall!.url).toBe("https://tts-clone.oneshots.co/v1/audio/speech/clone");
  });

  it('style="conversational" calls tts-voice.oneshots.co', async () => {
    mockFetchSuccess();
    const env = createMockEnv();
    await textToSpeech(env, { text: "Hello natural", style: "conversational" });

    const sesameCall = capturedFetchCalls.find(c =>
      c.url.includes("tts-voice.oneshots.co")
    );
    expect(sesameCall).toBeDefined();
    expect(sesameCall!.url).toBe("https://tts-voice.oneshots.co/v1/audio/speech");
  });

  it('style="workers-ai" calls env.AI.run with deepgram model', async () => {
    const env = createMockEnv();
    await textToSpeech(env, { text: "Hello workers", style: "workers-ai" });

    expect(env.AI.run).toHaveBeenCalledWith(
      "@cf/deepgram/aura-2-en",
      expect.objectContaining({ text: "Hello workers" })
    );
  });

  it("Kokoro failure falls back to Workers AI", async () => {
    mockFetchFailure(500); // Kokoro returns 500
    const env = createMockEnv();
    const result = await textToSpeech(env, { text: "Fallback test", style: "fast" });

    // Should have tried Kokoro first
    const kokoroCall = capturedFetchCalls.find(c =>
      c.url.includes("tts.oneshots.co")
    );
    expect(kokoroCall).toBeDefined();

    // Should have fallen back to Workers AI
    expect(env.AI.run).toHaveBeenCalledWith(
      "@cf/deepgram/aura-2-en",
      expect.objectContaining({ text: "Fallback test" })
    );

    // Result should mention fallback
    const parsed = JSON.parse(result);
    expect(parsed.model).toContain("kokoro fallback");
  });

  it("no text provided still makes the API call (text is empty string)", async () => {
    mockFetchSuccess();
    const env = createMockEnv();
    const result = await textToSpeech(env, {});

    // With empty text, it still calls Kokoro (default style) with empty input
    const ttsCall = capturedFetchCalls.find(c => c.url.includes("tts.oneshots.co"));
    expect(ttsCall).toBeDefined();
    // Result is JSON with audio_key
    const parsed = JSON.parse(result);
    expect(parsed.audio_key).toBeDefined();
  });

  it("includes Authorization header when SERVICE_TOKEN is set", async () => {
    mockFetchSuccess();
    const env = createMockEnv({ SERVICE_TOKEN: "my-secret-token" });
    await textToSpeech(env, { text: "Auth test" });

    const ttsCall = capturedFetchCalls.find(c => c.url.includes("tts.oneshots.co"));
    expect(ttsCall).toBeDefined();

    // Check that the Authorization header was set
    const headers = ttsCall!.init?.headers as Record<string, string>;
    expect(headers).toBeDefined();
    expect(headers["Authorization"]).toBe("Bearer my-secret-token");
  });

  it("does NOT include Authorization header when SERVICE_TOKEN is empty", async () => {
    mockFetchSuccess();
    const env = createMockEnv({ SERVICE_TOKEN: "" });
    await textToSpeech(env, { text: "No auth test" });

    const ttsCall = capturedFetchCalls.find(c => c.url.includes("tts.oneshots.co"));
    expect(ttsCall).toBeDefined();

    const headers = ttsCall!.init?.headers as Record<string, string>;
    // Should only have Content-Type, no Authorization
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("stores generated audio in env.STORAGE", async () => {
    mockFetchSuccess();
    const env = createMockEnv();
    await textToSpeech(env, { text: "Store test" });

    expect(env.STORAGE.put).toHaveBeenCalledWith(
      expect.stringMatching(/^audio\//),
      expect.any(Uint8Array),
      expect.objectContaining({
        customMetadata: expect.objectContaining({ text: "Store test" }),
      })
    );
  });
});

// ── STT Routing Tests ────────────────────────────────────────────────────────

describe("speechToText routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedFetchCalls = [];
  });

  it('provider="auto" tries stt.oneshots.co first', async () => {
    mockFetchSequence([
      // First call: download audio from URL
      { status: 200 },
      // Second call: GPU STT
      { status: 200, body: JSON.stringify({ text: "hello world", language: "en" }) },
    ]);
    const env = createMockEnv();
    const result = await speechToText(env, {
      audio_url: "https://example.com/audio.wav",
      provider: "auto",
    }, "test-session");

    const sttCall = capturedFetchCalls.find(c =>
      c.url.includes("stt.oneshots.co")
    );
    expect(sttCall).toBeDefined();
    expect(sttCall!.url).toBe("https://stt.oneshots.co/v1/audio/transcriptions");
  });

  it('provider="groq" with GROQ_API_KEY calls api.groq.com', async () => {
    mockFetchSequence([
      // First call: download audio from URL
      { status: 200 },
      // Second call: GPU STT fails (because provider=groq skips GPU)
      // Actually with provider="groq", it skips the GPU STT block
      // and goes straight to Groq
      { status: 200, body: JSON.stringify({ text: "groq result", language: "en" }) },
    ]);
    const env = createMockEnv({ GROQ_API_KEY: "gsk_testkey123" });
    const result = await speechToText(env, {
      audio_url: "https://example.com/audio.wav",
      provider: "groq",
    }, "test-session");

    const groqCall = capturedFetchCalls.find(c =>
      c.url.includes("api.groq.com")
    );
    expect(groqCall).toBeDefined();
    expect(groqCall!.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  });

  it('provider="workers-ai" calls env.AI.run with whisper model', async () => {
    mockFetchSequence([
      // Download audio
      { status: 200 },
    ]);
    const env = createMockEnv();
    env.AI.run = vi.fn(async () => ({ text: "workers ai result", language: "en" }));

    const result = await speechToText(env, {
      audio_url: "https://example.com/audio.wav",
      provider: "workers-ai",
    }, "test-session");

    expect(env.AI.run).toHaveBeenCalledWith(
      "@cf/openai/whisper",
      expect.objectContaining({ audio: expect.any(Array) })
    );
  });

  it("returns error when no audio_url or audio_path provided", async () => {
    const env = createMockEnv();
    const result = await speechToText(env, {}, "test-session");
    expect(result).toContain("requires audio_path or audio_url");
  });

  it("GPU STT failure falls back to Groq then Workers AI", async () => {
    let callCount = 0;
    capturedFetchCalls = [];
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      capturedFetchCalls.push({ url: urlStr, init });
      callCount++;
      if (callCount === 1) {
        // Audio download — success
        return new Response(FAKE_AUDIO, { status: 200 });
      }
      if (callCount === 2) {
        // GPU STT — failure
        return new Response("error", { status: 500 });
      }
      if (callCount === 3) {
        // Groq — failure
        return new Response("error", { status: 500 });
      }
      return new Response("error", { status: 500 });
    }) as any;

    const env = createMockEnv({ GROQ_API_KEY: "gsk_testkey" });
    env.AI.run = vi.fn(async () => ({ text: "workers fallback", language: "en" }));

    const result = await speechToText(env, {
      audio_url: "https://example.com/audio.wav",
      provider: "auto",
    }, "test-session");

    // Should have tried GPU STT
    const sttCall = capturedFetchCalls.find(c => c.url.includes("stt.oneshots.co"));
    expect(sttCall).toBeDefined();

    // Should have tried Groq
    const groqCall = capturedFetchCalls.find(c => c.url.includes("api.groq.com"));
    expect(groqCall).toBeDefined();

    // Should have fallen back to Workers AI
    expect(env.AI.run).toHaveBeenCalledWith(
      "@cf/openai/whisper",
      expect.any(Object)
    );

    const parsed = JSON.parse(result);
    expect(parsed.provider).toBe("workers-ai-whisper");
  });

  it("includes auth header on GPU STT calls", async () => {
    mockFetchSequence([
      // Download audio
      { status: 200 },
      // GPU STT success
      { status: 200, body: JSON.stringify({ text: "auth test", language: "en" }) },
    ]);
    const env = createMockEnv({ SERVICE_TOKEN: "stt-auth-token" });

    await speechToText(env, {
      audio_url: "https://example.com/audio.wav",
      provider: "auto",
    }, "test-session");

    const sttCall = capturedFetchCalls.find(c => c.url.includes("stt.oneshots.co"));
    expect(sttCall).toBeDefined();
    // The STT call uses FormData so headers are in init
    const headers = sttCall!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer stt-auth-token");
  });

  it("Groq auth uses GROQ_API_KEY (not SERVICE_TOKEN)", async () => {
    let callCount = 0;
    capturedFetchCalls = [];
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      capturedFetchCalls.push({ url: urlStr, init });
      callCount++;
      if (callCount === 1) {
        // Audio download
        return new Response(FAKE_AUDIO, { status: 200 });
      }
      // Groq success
      return new Response(JSON.stringify({ text: "groq auth", language: "en" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const env = createMockEnv({
      SERVICE_TOKEN: "gpu-token",
      GROQ_API_KEY: "gsk_groqkey",
    });

    await speechToText(env, {
      audio_url: "https://example.com/audio.wav",
      provider: "groq",
    }, "test-session");

    const groqCall = capturedFetchCalls.find(c => c.url.includes("api.groq.com"));
    expect(groqCall).toBeDefined();
    const headers = groqCall!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer gsk_groqkey");
  });
});
