import type { AtomicAgentConfig } from "../config/index.js";
import { readChatDaemonPidState, type ChatDaemonPidState } from "../local-llm/server/daemon-lifecycle.js";
import { isLoopbackUrlOnPort } from "../local-llm/server/managed-api-key.js";

/**
 * Whether the agent's own model process stands behind a llama.cpp address,
 * read when that address refused the key for good (ATO-1732).
 *
 *  - `running`: the address is the managed chat port and our recorded
 *    model process is alive.
 *  - `gone`: the address is the managed chat port and no model process of
 *    ours is there (no pid recorded, or a recorded pid that is dead). The
 *    server that answered 401 is then another program on that port.
 *  - `unknown`: not the managed chat port (an External server, a custom
 *    link), or the pid could not be read. The refused-key words stay.
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
 * Read from our pid records only (`readChatDaemonPidState`, the same
 * reading as the `daemon_state` tag of an `llm_failure` report), never
 * from the operating system's port table.
 */
export function readOwnEngineState(
  url: string,
  config: Pick<AtomicAgentConfig, "localModels" | "paths">,
  readPidState: (dataDir: string) => ChatDaemonPidState = readChatDaemonPidState,
): OwnEngineState {
  const { localModels } = config;
  if (localModels.mode !== "managed") return "unknown";
  const port = localModels.managed?.port;
  if (typeof port !== "number" || !isLoopbackUrlOnPort(url, [port])) return "unknown";
  let state: ChatDaemonPidState;
  try {
    state = readPidState(config.paths.localModelsDataDir);
  } catch {
    return "unknown";
  }
  return state === "alive" ? "running" : "gone";
}
