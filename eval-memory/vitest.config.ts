import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Memory-eval harness runs in its own vitest invocation, separate from
 * both `npm test` (hermetic unit tests) and `npm run eval` (one-turn
 * subprocess cases). Memory experiments touch:
 *
 *  - real `MemoryStore` / `EmbeddingStore` SQLite files
 *  - the managed llama-server (E2 / E3 / E4)
 *  - LLM-judge (E2 / E3 / E4)
 *
 * Pinned to one fork at a time because the experiments fight over
 * shared resources (llama slot pool, embedding daemon) and read/write
 * to per-experiment `<reports>/run-<ISO>/` directories that must not
 * interleave.
 */
export default defineConfig({
  root: resolve(__dirname, ".."),
  test: {
    include: ["eval-memory/**/*.eval.ts"],
    environment: "node",
    globals: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    maxConcurrency: 1,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    reporters: [
      "default",
      ["json", { outputFile: "eval-memory/reports/last-run.json" }],
    ],
  },
});
