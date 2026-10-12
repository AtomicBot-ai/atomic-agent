import { getConfig } from "../../config/index.js";

/** Opt-in for the Atomic Chat engine choice while Windows and Linux are unvalidated. */
export const ATOMIC_CORE_EXPERIMENTAL_ENV = "ATOMIC_AGENT_EXPERIMENTAL_ATOMIC_CORE";

interface EngineConfig {
  localModels: { managed: { engine?: string } };
}

/**
 * Whether the TUI offers Atomic Chat as an engine. True with the opt-in
 * variable set to "1", or when the saved config already selects
 * atomic-core, so nobody who chose it is stranded. The CLI
 * `models engine` command stays available either way.
 */
export function atomicCoreChoiceEnabled(
  config: EngineConfig = getConfig(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[ATOMIC_CORE_EXPERIMENTAL_ENV] === "1" || config.localModels.managed.engine === "atomic-core";
}
