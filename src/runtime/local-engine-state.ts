import type { AtomicAgentConfig } from "../config/index.js";
import type { LocalEngineState } from "../agent/agent-contract.js";
import {
  readManagedEngineLiveness,
  type ManagedEngineLiveness,
} from "../local-llm/index.js";

/** The built-in managed local link (`LlamaServerProvider`'s default id). */
const MANAGED_LOCAL_LINK = "local-llama";

/**
 * The managed engine's process state for the link a turn just failed on,
 * as the outage wait reads it (`AgentLoopDependencies.localEngineState`,
 * ATO-772).
 *
 * Judged only for the built-in `local-llama` link in managed mode, the same
 * link the local-models orchestrator starts and stops, and only while it is
 * the active text provider: the model the operator runs. Behind a cloud
 * provider it is a fallback tail the turn fell over to, and a cloud outage
 * there keeps its wait (the cloud may come back) instead of ending with
 * "the local model isn't running". Everything else is `unknown`, which
 * keeps the wait as it was: an external server
 * (`mode: "external"`) is the operator's to run and may come back on its
 * own, a cloud link is not a process on this machine, and a custom-id
 * `llama-server` entry is almost always a server the operator runs.
 *
 * `dead` covers a pid that is recorded and gone and no pid at all: either
 * way no model process exists and nothing is starting one. A start, load
 * or engine install under way reads `unknown` (see
 * `readManagedEngineLiveness`).
 */
export function readLocalEngineState(
  providerId: string | undefined,
  cfg: Pick<AtomicAgentConfig, "localModels" | "paths">,
  activeTextProvider: string,
  liveness: (dataDir: string) => ManagedEngineLiveness = readManagedEngineLiveness,
): LocalEngineState {
  if (providerId !== MANAGED_LOCAL_LINK) return "unknown";
  if (activeTextProvider !== MANAGED_LOCAL_LINK) return "unknown";
  if (cfg.localModels.mode !== "managed") return "unknown";
  let state: ManagedEngineLiveness;
  try {
    state = liveness(cfg.paths.localModelsDataDir);
  } catch {
    return "unknown";
  }
  if (state === "dead" || state === "no_pid") return "dead";
  return state === "alive" ? "alive" : "unknown";
}
