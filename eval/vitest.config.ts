import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Eval harness runs a *separate* vitest invocation from the unit-test
 * suite. We deliberately do not extend the root config: evals spawn the
 * agent CLI as a subprocess, hit the real llama-server, and take many
 * seconds per case — they must never accidentally run during `npm test`.
 *
 * Concurrency is pinned to 1 because the llama-server slot pool and the
 * sessions sqlite are shared resources; parallel cases would race on
 * cache slots and produce noisy timing metrics.
 */
export default defineConfig({
  root: resolve(__dirname, ".."),
  test: {
    include: ["eval/**/*.eval.ts"],
    environment: "node",
    globals: false,
    testTimeout: 360_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    maxConcurrency: 1,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    reporters: ["default", ["json", { outputFile: "eval/reports/last-run.json" }]],
  },
});
