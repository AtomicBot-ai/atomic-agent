import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      // Memory-fabric benchmark campaign config + harness unit tests.
      // Kept here (vs the eval-memory vitest config which only runs
      // *.eval.ts under `npm run eval:memory`) because these are
      // hermetic — no llama-server, no judge, no embedding daemon.
      "eval-memory/config/**/*.test.ts",
      "eval-memory/harness/**/*.test.ts",
      "eval-memory/experiments/**/*.test.ts",
      "eval-memory/competitors/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 15_000,
    reporters: ["default"],
    setupFiles: ["src/test-setup.ts"],
  },
});
