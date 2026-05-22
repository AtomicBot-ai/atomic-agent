#!/usr/bin/env node
// LoCoMo orchestrator — brings up the managed daemon (or honours
// ATOMIC_AGENT_EVAL_LLAMA_URL) and spawns vitest against the
// `experiments/locomo/locomo.eval.ts` spec. Mirrors run-e1.mjs.

import {
  bringUpDaemon,
  installSignalHandlers,
  loadEnv,
  makeLog,
  runVitest,
  teardownDaemon,
} from "./_lib.mjs";

const log = makeLog("locomo");
installSignalHandlers(log);

async function main() {
  loadEnv();
  const { url, startedByUs, embedUrl } = await bringUpDaemon(log);

  const extraEnv = {};
  if (url) extraEnv.ATOMIC_AGENT_EVAL_LLAMA_URL = url;
  if (embedUrl) extraEnv.ATOMIC_AGENT_EVAL_EMBED_URL = embedUrl;

  let exitCode = 1;
  try {
    log(`spawning vitest (profiles=${process.env.ATOMIC_AGENT_LOCOMO_PROFILES ?? "all"})`);
    exitCode = await runVitest({
      filter: ["-t", "LoCoMo — multi-profile"],
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
