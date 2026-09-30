/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    port: 5173,
    proxy: { "/v1": api, "/readyz": api, "/healthz": api, "/metrics": api },
  },
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 800 },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/store/**"],
      exclude: ["src/lib/types.ts", "src/lib/sync/types.ts", "src/lib/sync/factory.ts"],
      thresholds: { lines: 80, functions: 75, statements: 80, branches: 70 },
    },
  },
});
