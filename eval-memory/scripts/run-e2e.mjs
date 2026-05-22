#!/usr/bin/env node
// E2E orchestrator — runs every `E2E-...` describe block under a
// managed llama-server.
//
// Usage:
//   npm run eval:memory:e2e             # all five E2E scenarios
//   npm run eval:memory:e2e -- -t "E2E-1"
//   npm run eval:memory:e2e -- -t "E2E-3"
//
// Each scenario boots a fresh `<stateDir>` and is responsible for its
// own teardown. The daemon stays up across scenarios — scenarios are
// allowed to call `runConsolidatorTick` which talks to it.

import {
  bringUpDaemon,
  installSignalHandlers,
  loadEnv,
  makeLog,
  runVitest,
  teardownDaemon,
} from "./_lib.mjs";

const log = makeLog("e2e");
installSignalHandlers(log);

async function main() {
  loadEnv();
  const forwarded = process.argv.slice(2);
  const { url, startedByUs } = await bringUpDaemon(log);
  if (!url) {
    log(`could not resolve chat llama URL — aborting`);
    return 2;
  }

  // Vitest only accepts one `-t`. Default to "E2E-" but step out of
  // the way when the user passes their own filter (e.g. `-t "E2E-1"`).
  const userHasTestFilter = forwarded.some(
    (arg, i) => arg === "-t" || arg === "--testNamePattern" || (arg.startsWith("-t") && i < forwarded.length),
  );
  const filter = userHasTestFilter ? [] : ["-t", "E2E-"];

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
