import type { AtomicAgentConfig } from "../config/index.js";
import type { LocalEngineState, LocalEngineVerdict } from "../agent/agent-contract.js";
import {
  explainManagedEngineLiveness,
  readManagedEngineLiveness,
  type ManagedEngineLiveness,
  type ManagedEngineLivenessReason,
  type ManagedEngineLivenessReport,
} from "../local-llm/index.js";

/** The built-in managed local link (`LlamaServerProvider`'s default id). */
const MANAGED_LOCAL_LINK = "local-llama";
/** The Atomic Chat app's Local API Server preset (`provider-presets.ts`). */
const ATOMIC_CHAT_LINK = "atomic-chat";

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
 * The `atomic-chat` preset link, while it is the active text provider,
 * reads `atomic_chat_app` (ATO-1278): its server is the Atomic Chat
 * desktop app, which nothing here starts or restarts, so the outage wait
 * ends a refused connection there after a short start grace instead of
 * waiting out the budget. As a fallback tail behind another provider it
 * stays `unknown`, for the same reason as `local-llama` above.
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
  if (providerId === ATOMIC_CHAT_LINK) {
    return activeTextProvider === ATOMIC_CHAT_LINK ? "atomic_chat_app" : "unknown";
  }
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

/**
 * Why `explainLocalEngineState` reads what it reads (ATO-1432), as a fixed
 * word for error reports: the managed liveness branch
 * (`ManagedEngineLivenessReason`), or why the engine was not looked at.
 *
 *   - `not_local_link`        the link is neither `local-llama` nor
 *                             `atomic-chat` (a cloud or custom link).
 *   - `not_active_provider`   a local link that is a fallback tail behind
 *                             another active provider.
 *   - `not_managed`           `local-llama` in external mode.
 *   - `atomic_chat_app`       the Atomic Chat app's server, active.
 *   - `liveness_probe_failed` the liveness read threw.
 */
export type LocalEngineStateReason =
  | ManagedEngineLivenessReason
  | "not_local_link"
  | "not_active_provider"
  | "not_managed"
  | "atomic_chat_app"
  | "liveness_probe_failed";

/**
 * `readLocalEngineState` with the reason as a fixed word (ATO-1432), for
 * the outage wait to report what it decided on. Same rules, same states.
 */
export function explainLocalEngineState(
  providerId: string | undefined,
  cfg: Pick<AtomicAgentConfig, "localModels" | "paths">,
  activeTextProvider: string,
  explain: (dataDir: string) => ManagedEngineLivenessReport = explainManagedEngineLiveness,
): LocalEngineVerdict & { reason: LocalEngineStateReason } {
  if (providerId === ATOMIC_CHAT_LINK) {
    return activeTextProvider === ATOMIC_CHAT_LINK
      ? { state: "atomic_chat_app", reason: "atomic_chat_app" }
      : { state: "unknown", reason: "not_active_provider" };
  }
  if (providerId !== MANAGED_LOCAL_LINK) return { state: "unknown", reason: "not_local_link" };
  if (activeTextProvider !== MANAGED_LOCAL_LINK) return { state: "unknown", reason: "not_active_provider" };
  if (cfg.localModels.mode !== "managed") return { state: "unknown", reason: "not_managed" };
  let report: ManagedEngineLivenessReport;
  try {
    report = explain(cfg.paths.localModelsDataDir);
  } catch {
    return { state: "unknown", reason: "liveness_probe_failed" };
  }
  return { state: localEngineStateOf(report.state), reason: report.reason };
}

function localEngineStateOf(state: ManagedEngineLiveness): LocalEngineState {
  if (state === "dead" || state === "no_pid") return "dead";
  return state === "alive" ? "alive" : "unknown";
}
