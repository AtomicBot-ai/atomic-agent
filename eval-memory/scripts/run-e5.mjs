#!/usr/bin/env node
// E5 orchestrator — vote decision audit.
//
// Phase 7a's voting sub-call runs on the reflection slot of the chat
// llama-server. This script brings up the managed daemon (if not
// already running), forwards its URL into the vitest run via env,
// and tears the daemon down on exit (only if we were the ones who
// started it).
//
// Judge (OpenRouter / gpt-4o-mini) must be configured separately —
// without OPENROUTER_API_KEY the spec skips with a clear message.
//
// Usage:
//   npm run eval:memory:e5
//   ATOMIC_AGENT_EVAL_LLAMA_URL=http://... npm run eval:memory:e5

import {
  bringUpDaemon,
  installSignalHandlers,
  loadEnv,
  makeLog,
  runVitest,
  teardownDaemon,
} from "./_lib.mjs";

const log = makeLog("e5");
installSignalHandlers(log);

async function main() {
  loadEnv();
  const forwarded = process.argv.slice(2);
  const { url, startedByUs } = await bringUpDaemon(log);
  if (!url) {
    log(`could not resolve chat llama URL — aborting`);
    return 2;
  }

  if (!process.env.OPENROUTER_API_KEY && !process.env.ATOMIC_AGENT_JUDGE_API_KEY) {
    log(`note: no judge API key in env; the spec will skip with a clear message`);
  }

  let exitCode = 1;
  try {
    log(`spawning vitest`);
    exitCode = await runVitest({
      filter: ["-t", "E5 — vote decision audit"],
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
