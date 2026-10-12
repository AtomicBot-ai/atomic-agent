/**
 * The opt-in variable that used to offer Atomic Chat as an engine. Atomic
 * Core is now the default engine for everybody and the choice is always
 * offered; the variable is ignored. Kept so existing importers compile.
 * @deprecated No longer read.
 */
export const ATOMIC_CORE_EXPERIMENTAL_ENV = "ATOMIC_AGENT_EXPERIMENTAL_ATOMIC_CORE";

/**
 * Whether Atomic Chat may be selected as an engine. Always true: Atomic Core
 * is the default engine, and llama.cpp (`llama-server`) stays selectable as
 * the way back. The parameters are accepted and ignored for compatibility.
 */
export function atomicCoreChoiceEnabled(_config?: unknown, _env?: NodeJS.ProcessEnv): boolean {
  return true;
}
