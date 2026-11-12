import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Attack suite (`npm run eval:attacks`, ATO-623). Same settings as
 * `vitest.config.ts` (one case at a time against the shared
 * llama-server), but only the attack spec, so `npm run eval` numbers
 * are unchanged and attack runs are not mixed into them.
 */
export default defineConfig({
  root: resolve(__dirname, ".."),
  test: {
    include: ["eval/attacks.attack.ts"],
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
    reporters: ["default", ["json", { outputFile: "eval/reports/attacks-last-run.json" }]],
  },
});
