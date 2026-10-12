import { getConfig } from "../../config/index.js";

/** Opt-in for the Atomic Chat engine choice while Windows and Linux are unvalidated. */
export const ATOMIC_CORE_EXPERIMENTAL_ENV = "ATOMIC_AGENT_EXPERIMENTAL_ATOMIC_CORE";

interface EngineConfig {
  localModels: { managed: { engine?: string } };
}

/**
 * Whether Atomic Chat may be selected as an engine, in the TUI and in
 * `models engine atomic-core`. True with the opt-in variable set to "1",
 * or when the saved config already selects atomic-core, so nobody who
 * chose it is stranded. Switching back to llama-server is never gated.
 */
export function atomicCoreChoiceEnabled(
  config: EngineConfig = getConfig(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[ATOMIC_CORE_EXPERIMENTAL_ENV] === "1" || config.localModels.managed.engine === "atomic-core";
}
