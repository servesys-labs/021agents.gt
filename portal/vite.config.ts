import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@refinedev/")) {
            return "vendor-refine";
          }
          if (id.includes("@tremor/")) {
            return "vendor-tremor";
          }
          if (id.includes("@clerk/")) {
            return "vendor-clerk";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api": "http://localhost:8340",
      "/health": "http://localhost:8340",
      "/.well-known": "http://localhost:8340",
      "/a2a": "http://localhost:8340",
      "/docs": "http://localhost:8340",
    },
  },
});
