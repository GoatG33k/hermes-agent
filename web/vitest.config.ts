import { defineConfig } from "vitest/config";
import path from "path";

// Unit tests for the web dashboard. The chat store is framework-agnostic and
// only needs the Node environment plus an injected in-memory Storage fake, so
// we avoid pulling in jsdom/testing-library here. Component-level tests, if
// added later, can opt into `environment: "jsdom"` per-file via a
// `// @vitest-environment jsdom` pragma.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["dist/**", "node_modules/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
