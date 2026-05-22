#!/usr/bin/env node
// E8 orchestrator — procedure lifecycle bench (phase 7b).
//
// Pure deterministic vitest run. No managed daemon, no judge. Same
// shape as run-e7.mjs so the eval:memory:* family has a uniform
// invocation surface.
//
// Usage:
//   npm run eval:memory:e8

import { installSignalHandlers, loadEnv, makeLog, runVitest } from "./_lib.mjs";

const log = makeLog("e8");
installSignalHandlers(log);

async function main() {
  loadEnv();
  const forwarded = process.argv.slice(2);
  log(`spawning vitest`);
  const exitCode = await runVitest({
    filter: ["-t", "E8 — procedure lifecycle bench"],
    forwarded,
  });
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`fatal: ${err instanceof Error ? err.stack ?? err.message : err}`);
    process.exit(2);
  });
