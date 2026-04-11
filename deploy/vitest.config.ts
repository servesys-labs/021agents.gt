import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
    server: {
      deps: {
        // @cloudflare/containers@0.1.1 ships dist/index.js with extensionless
        // `export ... from './lib/container'` but no `"type": "module"` in
        // its package.json, so Node's native ESM resolver rejects it.
        // Inlining routes the module through Vite's resolver, which handles
        // the extensionless path correctly.
        // Chain: test → tools.ts → @cloudflare/sandbox → @cloudflare/containers.
        inline: [/@cloudflare\/containers/, /@cloudflare\/sandbox/],
      },
    },
  },
  resolve: {
    alias: [
      // `cloudflare:workers` is a virtual module provided by workerd at
      // runtime — no such package under Node. Point it at a stub so any
      // transitive chain that touches `DurableObject` / `WorkerEntrypoint`
      // loads cleanly under vitest.
      {
        find: "cloudflare:workers",
        replacement: fileURLToPath(
          new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
        ),
      },
    ],
  },
});
