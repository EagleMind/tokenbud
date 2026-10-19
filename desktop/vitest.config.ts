import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests for the frontend's logic (no browser needed: storage and IndexedDB are optional
// in the code under test, and fetch is mocked).
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
