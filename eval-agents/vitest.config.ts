import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// The per-case adapter wall-clock cap (ATOMIC_AGENT_GAIA_TIMEOUT_MS, set by
// the orchestrator scripts) must fire BEFORE vitest's own testTimeout so a
// slow case resolves as a graceful `timeout` result instead of vitest
// hard-killing the worker (which corrupts the report and mis-attributes the
// failure). We derive testTimeout = adapterTimeout + margin so it is always
// strictly greater, with headroom for the SIGKILL/close + scoring tail.
const ADAPTER_TIMEOUT_MS = Number(process.env.ATOMIC_AGENT_GAIA_TIMEOUT_MS ?? "600000");
const TEST_TIMEOUT_MARGIN_MS = 220_000;

export default defineConfig({
  root: resolve(__dirname, ".."),
  test: {
    include: ["eval-agents/**/*.eval.ts", "eval-agents/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: ADAPTER_TIMEOUT_MS + TEST_TIMEOUT_MARGIN_MS,
    hookTimeout: 220_000,
    fileParallelism: false,
    maxConcurrency: 1,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    reporters: [
      "default",
      ["json", { outputFile: "eval-agents/reports/last-run.json" }],
    ],
  },
});
