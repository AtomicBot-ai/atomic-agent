#!/usr/bin/env node
// LongMemEval orchestrator. Mirrors run-locomo.mjs.

import {
  bringUpDaemon,
  installSignalHandlers,
  loadEnv,
  makeLog,
  runVitest,
  teardownDaemon,
} from "./_lib.mjs";

const log = makeLog("longmemeval");
installSignalHandlers(log);

async function main() {
  loadEnv();
  const { url, startedByUs, embedUrl } = await bringUpDaemon(log);

  const extraEnv = {};
  if (url) extraEnv.ATOMIC_AGENT_EVAL_LLAMA_URL = url;
  if (embedUrl) extraEnv.ATOMIC_AGENT_EVAL_EMBED_URL = embedUrl;

  let exitCode = 1;
  try {
    log(`spawning vitest (profiles=${process.env.ATOMIC_AGENT_LONGMEMEVAL_PROFILES ?? "all"})`);
    exitCode = await runVitest({
      filter: ["-t", "LongMemEval — multi-profile"],
      extraEnv,
      forwarded: process.argv.slice(2),
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
