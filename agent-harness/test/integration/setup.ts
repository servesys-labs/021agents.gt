import { beforeAll, afterAll } from "vitest";

// Warm up the Workers runtime module graph
beforeAll(async () => {
  try {
    // @ts-ignore — exports may not exist in non-Workers context
    await exports.default?.fetch?.("http://warmup/");
  } catch {}
}, 30_000);

// Allow WebSockets to close cleanly between test files
afterAll(() => new Promise((resolve) => setTimeout(resolve, 100)));
