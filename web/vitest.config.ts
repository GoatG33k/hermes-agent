import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ESM-safe __dirname: this config is loaded as an ES module, where the CommonJS
// `__dirname` global is not defined.
const dirname = path.dirname(fileURLToPath(import.meta.url));

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
      "@": path.resolve(dirname, "./src"),
    },
  },
});
