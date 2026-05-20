#!/usr/bin/env node
// v2.5 orchestrator — runs every Memory Fabric v2.5 (memU-inspired)
// integration test (E9, E10, E11, E12) under a managed llama-server.
//
// Intentionally separate from `eval:memory` and `eval:memory:e2e`:
// v2.5 features are opt-in and decoupled from the base v2 release
// gate. The user opted (Q3) for a dedicated entry point so flipping
// the v2.5 flags on stays a deliberate operator action.
//
// Usage:
//   npm run eval:memory:v25                  # all four experiments
//   npm run eval:memory:v25 -- -t "E9"       # one experiment
//   npm run eval:memory:v25 -- -t "E10"
//   npm run eval:memory:v25 -- -t "E11"
//   npm run eval:memory:v25 -- -t "E12"
//
// Each experiment boots its own fresh `<stateDir>`. The daemon stays
// up across experiments.

import {
  bringUpDaemon,
  installSignalHandlers,
  loadEnv,
  makeLog,
  runVitest,
  teardownDaemon,
} from "./_lib.mjs";

const log = makeLog("v25");
installSignalHandlers(log);

async function main() {
  loadEnv();
  const forwarded = process.argv.slice(2);
  const { url, startedByUs } = await bringUpDaemon(log);
  if (!url) {
    log(`could not resolve chat llama URL — aborting`);
    return 2;
  }

  const userHasTestFilter = forwarded.some(
    (arg, i) =>
      arg === "-t" ||
      arg === "--testNamePattern" ||
      (arg.startsWith("-t") && i < forwarded.length),
  );
  // Default filter: every v2.5 describe block. Each spec starts its
  // top-level `describe` with "E9 — ", "E10 — ", "E11 — " or "E12 — ".
  const filter = userHasTestFilter ? [] : ["-t", "v2.5"];

  let exitCode = 1;
  try {
    log(`spawning vitest`);
    exitCode = await runVitest({
      filter,
      extraEnv: { ATOMIC_AGENT_EVAL_LLAMA_URL: url },
      forwarded,
    });
  } finally {
    teardownDaemon(log, startedByUs);
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`fatal: ${err instanceof Error ? err.stack ?? err.message : err}`);
    process.exit(2);
  });
