#!/usr/bin/env node
// E7 orchestrator — lesson lifecycle bench.
//
// Pure deterministic vitest run. No managed daemon, no judge. Kept
// as a script for parity with E1/E3/E4 so the `eval:memory:*` family
// has a uniform invocation surface.
//
// Usage:
//   npm run eval:memory:e7

import { installSignalHandlers, loadEnv, makeLog, runVitest } from "./_lib.mjs";

const log = makeLog("e7");
installSignalHandlers(log);

async function main() {
  loadEnv();
  const forwarded = process.argv.slice(2);
  log(`spawning vitest`);
  const exitCode = await runVitest({
    filter: ["-t", "E7 — lesson lifecycle bench"],
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
