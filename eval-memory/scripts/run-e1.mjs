#!/usr/bin/env node
// E1 orchestrator — bring up the managed daemon (if needed) and spawn
// vitest against eval-memory/experiments/e1-recall-precision/.

import {
  bringUpDaemon,
  installSignalHandlers,
  loadEnv,
  makeLog,
  runVitest,
  teardownDaemon,
} from "./_lib.mjs";

const log = makeLog("e1");
installSignalHandlers(log);

function parseArgs(argv) {
  let bm25Only = false;
  const forwarded = [];
  for (const arg of argv) {
    if (arg === "--bm25-only") bm25Only = true;
    else forwarded.push(arg);
  }
  return { bm25Only, forwarded };
}

async function main() {
  loadEnv();
  const { bm25Only, forwarded } = parseArgs(process.argv.slice(2));

  // BM25-only path does not need any daemon.
  if (bm25Only) {
    log(`--bm25-only flag set; skipping daemon control`);
    return runVitest({ filter: ["-t", "E1 — recall precision"], forwarded });
  }

  const { url, startedByUs, embedUrl } = await bringUpDaemon(log);

  const extraEnv = {};
  if (embedUrl) {
    extraEnv.ATOMIC_AGENT_EVAL_EMBED_URL = embedUrl;
    if (process.env.ATOMIC_AGENT_EVAL_EMBED_DIM) {
      extraEnv.ATOMIC_AGENT_EVAL_EMBED_DIM = process.env.ATOMIC_AGENT_EVAL_EMBED_DIM;
    } else {
      log(`note: ATOMIC_AGENT_EVAL_EMBED_DIM not set; spec will fall back to bm25-only`);
    }
    if (process.env.ATOMIC_AGENT_EVAL_EMBED_MODEL) {
      extraEnv.ATOMIC_AGENT_EVAL_EMBED_MODEL = process.env.ATOMIC_AGENT_EVAL_EMBED_MODEL;
    }
  }
  if (url) extraEnv.ATOMIC_AGENT_EVAL_LLAMA_URL = url;

  let exitCode = 1;
  try {
    log(`spawning vitest (modes ${embedUrl && extraEnv.ATOMIC_AGENT_EVAL_EMBED_DIM ? "= bm25-only + hybrid + hybrid+links" : "= bm25-only"})`);
    exitCode = await runVitest({
      filter: ["-t", "E1 — recall precision"],
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
