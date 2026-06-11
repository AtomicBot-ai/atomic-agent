#!/usr/bin/env node
// Smoke matrix: committed GAIA fixtures × selected agents.

import {
  bringUpDaemons,
  installSignalHandlers,
  loadEnv,
  makeLog,
  runVitest,
  teardownDaemons,
} from "./_lib.mjs";

const log = makeLog("smoke");
installSignalHandlers(log);

async function main() {
  loadEnv();
  const { chatUrl, embedUrl, startedByUs } = await bringUpDaemons(log);
  if (!chatUrl) {
    log("no chat llama URL — set ATOMIC_AGENT_EVAL_LLAMA_URL or start managed models");
    return 2;
  }

  const extraEnv = {
    ATOMIC_AGENT_EVAL_LLAMA_URL: chatUrl,
    ATOMIC_AGENT_GAIA_SOURCE: "fixtures",
    ATOMIC_AGENT_GAIA_MAX_STEPS: process.env.ATOMIC_AGENT_GAIA_MAX_STEPS ?? "20",
    ATOMIC_AGENT_GAIA_TIMEOUT_MS: process.env.ATOMIC_AGENT_GAIA_TIMEOUT_MS ?? "300000",
  };
  if (embedUrl) extraEnv.ATOMIC_AGENT_EVAL_EMBED_URL = embedUrl;

  let code = 1;
  try {
    code = await runVitest({
      extraEnv,
      forwarded: process.argv.slice(2),
    });
  } finally {
    teardownDaemons(log, startedByUs);
  }
  return code;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    log(`fatal: ${err?.stack ?? err}`);
    process.exit(1);
  });
