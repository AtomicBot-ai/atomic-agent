#!/usr/bin/env node
// E3 orchestrator — reflection signal-to-noise audit.
//
// Requires the chat llama-server (any model). Brings up the managed
// daemon if not already running, forwards the URL via env to vitest.
//
// Judge (OpenRouter / gpt-4o-mini) must be configured separately —
// without OPENROUTER_API_KEY the spec is skipped at runtime.
//
// Usage:
//   npm run eval:memory:e3
//   ATOMIC_AGENT_EVAL_LLAMA_URL=http://... npm run eval:memory:e3

import {
  bringUpDaemon,
  installSignalHandlers,
  loadEnv,
  makeLog,
  runVitest,
  teardownDaemon,
} from "./_lib.mjs";

const log = makeLog("e3");
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
      filter: ["-t", "E3 — reflection signal-to-noise audit"],
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
