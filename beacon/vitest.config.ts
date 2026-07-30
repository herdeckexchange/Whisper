import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Provider adapters use fake timers for retry/backoff tests; keep them isolated.
    isolate: true,
  },
});
