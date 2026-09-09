import { getConfig } from "../../config/index.js";
import {
  activeTextProviderIsLlamaServer,
  resolveLlmConfig,
} from "../../llm/provider/registry/index.js";
import type { TuiAction } from "../tui-action.js";

/**
 * The two daemon-lifecycle calls a restart is made of, injected so this
 * module never reaches into `LocalModelsOrchestrator` (and so the order
 * they run in is testable without spawning llama-server).
 */
export interface DaemonRestartDeps {
  /** Emit onto the TUI event bus — the feed, not the panel's error slot. */
  emit(action: TuiAction): void;
  /**
   * Stop ONLY the managed chat daemon. Leaves the embedding daemon (and
   * therefore hybrid recall) running, and is a no-op when nothing is up.
   * Resolves false when the stop failed and the process is still up — it
   * reports the failure itself, it does not throw.
   */
  stopChatDaemonOnly(): Promise<boolean>;
  /** Start the managed chat daemon; owns the model/backend preflight. */
  startDaemon(): Promise<boolean>;
}

/**
 * "Restart the local model server" — the action the operator has when a
 * wedged llama-server has to be bounced without losing anything else.
 *
 * Deliberately narrow:
 * - It restarts the **chat** daemon only. `stopDaemon` (the `s` toggle)
 *   also tears the embedding daemon down and flips
 *   `memory.embeddings.enabled` off, so stop-then-start by hand silently
 *   costs hybrid recall. `stopChatDaemonOnly` does not.
 * - It never restarts anything the TUI does not own: external mode and a
 *   live cloud route each get a line saying so and nothing else happens.
 * - It never fires by itself. An unattended relaunch of a 27B model in
 *   the middle of a turn is not a default; a provider outage is handled
 *   by the fallback chain, not by respawning a server.
 *
 * Narration goes to the runtime feed (`runtime_info`). The local-models
 * panel's `errorLine` is wiped by every refresh — and `startDaemon` ends
 * on one — so a notice parked there would be invisible; a *failure* still
 * sets `local_models_daemon_error_set`, matching `stopDaemon`.
 *
 * @returns true only when the chat daemon came back up.
 */
export async function restartLocalDaemon(deps: DaemonRestartDeps): Promise<boolean> {
  const cfg = getConfig();
  // KIND-based, the predicate `local-turn-gate` and the runtime share:
  // a `llama-server` entry under a custom id is still the local route.
  const llm = resolveLlmConfig(cfg);
  if (!activeTextProviderIsLlamaServer(llm)) {
    // Careful with the wording: "nothing local to restart" is not true.
    // `fallback.appendLocal` defaults to true, so a managed daemon is
    // very often still up and still in the chain behind a cloud head.
    // What is true is that this action bounces the daemon behind the
    // ACTIVE route, and that is not one — switching the route back is
    // the operator's call, not something a restart key should do.
    deps.emit({
      type: "runtime_info",
      line:
        `local-llm: the active chat route is "${llm.activeTextProvider}", not the ` +
        "local one — nothing to restart on this route; run /llm check to probe it",
    });
    return false;
  }
  if (cfg.localModels.mode !== "managed") {
    deps.emit({
      type: "runtime_info",
      line:
        `local-llm: external mode — ${cfg.localModels.url} is not ours to manage; ` +
        "restart that llama-server yourself",
    });
    return false;
  }
  deps.emit({
    type: "runtime_info",
    line: "local-llm: restarting the model server…",
  });
  let stopped: boolean;
  try {
    stopped = await deps.stopChatDaemonOnly();
  } catch (e) {
    // `stopChatDaemonOnly` reports its own failures, but a throw from it
    // must not leave the operator staring at "restarting…" forever.
    const msg = e instanceof Error ? e.message : String(e);
    deps.emit({ type: "local_models_daemon_error_set", message: msg });
    deps.emit({
      type: "runtime_info",
      line: `local-llm: restart failed — ${msg}`,
    });
    return false;
  }
  if (!stopped) {
    // The old process is still up and still owns the port. Starting
    // anyway would spawn a second `llama-server` — the only guard in
    // `daemon-lifecycle.startDaemon` is a pid file the survivor still
    // owns, and once a second spawn overwrites it the first is orphaned
    // beyond the reach of any TUI stop. `stopChatDaemonOnly` has already
    // set the error line, so this only names the consequence.
    deps.emit({
      type: "runtime_info",
      line:
        "local-llm: restart aborted — the chat daemon is still up; starting " +
        "on top of it would leave a second server nothing can stop",
    });
    return false;
  }
  return await deps.startDaemon();
}
