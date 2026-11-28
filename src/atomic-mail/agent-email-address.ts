import type { AtomicMailConfig } from "../config/index.js";
import { readAtomicMailApiKey } from "./atomic-mail-store.js";

/**
 * The agent's own address for the `email:` line of the stable prefix.
 * Only an inbox this machine holds the key for is the agent's to use.
 * The runtime and `trace replay` both call this, so a replay rebuilds
 * the same capabilities line the session saw (ATO-2491).
 */
export function agentEmailAddress(
  atomicMail: Pick<AtomicMailConfig, "address">,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return readAtomicMailApiKey(env) ? atomicMail.address : null;
}
