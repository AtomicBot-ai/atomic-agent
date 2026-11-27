import type { AtomicAgentConfig } from "../config/index.js";
import { readManagedEngineLiveness, type ManagedEngineLiveness } from "../local-llm/server/engine-liveness.js";
import { isLoopbackUrlOnPort } from "../local-llm/server/managed-api-key.js";

/**
 * Whether the agent's own model process stands behind a llama.cpp address,
 * read when that address refused the key for good (ATO-1732).
 *
 *  - `running`: the address is the managed chat port and our recorded
 *    model process is alive.
 *  - `gone`: the address is the managed chat port, no model process of
 *    ours is there (a recorded pid that is dead, or none recorded) and
 *    nothing is bringing one up (no engine lock held, no start pending).
 *    The server that answered 401 is then another program on that port.
 *  - `unknown`: not the managed chat port (an External server, a custom
 *    link), a start, load or install under way (our own server may be the
 *    one answering before its pid is written), or the state could not be
 *    read. The refused-key words stay.
 */
export type OwnEngineState = "running" | "gone" | "unknown";

/**
 * The sentence a standing 401 gets when our own model is not running: the
 * server that refused the key is someone else's, so "restart it" would
 * send the person to restart a model that is not there.
 */
export const FOREIGN_KEY_REFUSAL_MESSAGE =
  "Another program answers on the local model's address and refuses the agent's key; " +
  "the agent's own model is not running there (for example Atomic Chat or a second copy of the engine holds the port).";

/** What to do, with no commands in it, the same advice as `LocalPortTakenError`. */
export const FOREIGN_KEY_REFUSAL_ADVICE =
  "Close that program and start the model again, or set a different port in localModels.managed.port.";

/**
 * Read with `readManagedEngineLiveness`, the same lock-aware reading the
 * turn's `LocalPortTakenError` conversion uses (ATO-1277): a held engine
 * lock or a pending start reads `unknown`, never `gone`. Pid records and
 * the lock only, never the operating system's port table.
 */
export function readOwnEngineState(
  url: string,
  config: Pick<AtomicAgentConfig, "localModels" | "paths">,
  liveness: (dataDir: string) => ManagedEngineLiveness = readManagedEngineLiveness,
): OwnEngineState {
  const { localModels } = config;
  if (localModels.mode !== "managed") return "unknown";
  const port = localModels.managed?.port;
  if (typeof port !== "number" || !isLoopbackUrlOnPort(url, [port])) return "unknown";
  let state: ManagedEngineLiveness;
  try {
    state = liveness(config.paths.localModelsDataDir);
  } catch {
    return "unknown";
  }
  if (state === "alive") return "running";
  return state === "dead" || state === "no_pid" ? "gone" : "unknown";
}
