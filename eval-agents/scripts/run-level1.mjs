#!/usr/bin/env node
// Full GAIA validation Level 1 matrix (requires datasets download).

import {
  bringUpDaemons,
  installSignalHandlers,
  loadEnv,
  makeLog,
  runVitest,
  teardownDaemons,
} from "./_lib.mjs";

const log = makeLog("level1");
installSignalHandlers(log);

async function main() {
  loadEnv();
  const { chatUrl, embedUrl, startedByUs } = await bringUpDaemons(log);
  if (!chatUrl) {
    log("no chat llama URL");
    return 2;
  }

  const extraEnv = {
    ATOMIC_AGENT_EVAL_LLAMA_URL: chatUrl,
    ATOMIC_AGENT_GAIA_SOURCE: "hf",
    ATOMIC_AGENT_GAIA_LEVEL: "1",
    ATOMIC_AGENT_GAIA_MAX_STEPS: process.env.ATOMIC_AGENT_GAIA_MAX_STEPS ?? "40",
    ATOMIC_AGENT_GAIA_TIMEOUT_MS: process.env.ATOMIC_AGENT_GAIA_TIMEOUT_MS ?? "900000",
  };
  if (embedUrl) extraEnv.ATOMIC_AGENT_EVAL_EMBED_URL = embedUrl;

  let code = 1;
  try {
    code = await runVitest({ extraEnv, forwarded: process.argv.slice(2) });
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
