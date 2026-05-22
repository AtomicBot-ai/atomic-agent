#!/usr/bin/env node
// E2 orchestrator — paired multi-turn sessions.
//
// Brings up the managed chat daemon (and detects an embedding daemon
// if one is already on a well-known port), then spawns vitest. Each
// scenario boots a fresh subprocess of `atomic-agent run` so the
// daemon must stay up for the full duration of the test.

import {
  bringUpDaemon,
  installSignalHandlers,
  loadEnv,
  makeLog,
  runVitest,
  teardownDaemon,
} from "./_lib.mjs";

const log = makeLog("e2");
installSignalHandlers(log);

async function main() {
  loadEnv();
  const forwarded = process.argv.slice(2);
  const { url, startedByUs, embedUrl } = await bringUpDaemon(log);
  if (!url) {
    log(`could not resolve chat llama URL — aborting`);
    return 2;
  }

  if (!process.env.OPENROUTER_API_KEY && !process.env.ATOMIC_AGENT_JUDGE_API_KEY) {
    log(`note: no judge API key in env; the spec will skip with a clear message`);
  }

  const extraEnv = { ATOMIC_AGENT_EVAL_LLAMA_URL: url };
  if (embedUrl) extraEnv.ATOMIC_AGENT_EVAL_EMBED_URL = embedUrl;
  if (process.env.ATOMIC_AGENT_EVAL_EMBED_MODEL) {
    extraEnv.ATOMIC_AGENT_EVAL_EMBED_MODEL = process.env.ATOMIC_AGENT_EVAL_EMBED_MODEL;
  }

  let exitCode = 1;
  try {
    log(`spawning vitest (each scenario runs the agent twice — expect ~minutes per scenario)`);
    exitCode = await runVitest({
      filter: ["-t", "E2 — paired multi-turn sessions"],
      extraEnv,
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
