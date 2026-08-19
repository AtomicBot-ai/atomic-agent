import type { RunModeName } from "../../config/llm-run-mode-config.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import type { TuiAction } from "../tui-action.js";

/**
 * The leg a run mode cannot start without, named by the screen that
 * fixes it rather than by the config key it is missing.
 *
 * Two targets, not one, because the two legs are repaired in completely
 * different places: a cloud provider is an entry in `llm.providers` and
 * is added by the provider wizard, while the local leg is a llama-server
 * — a backend binary, a downloaded model and a running daemon — which is
 * the Local pane's whole subject. Sending "Local is not set up" to the
 * add-a-cloud-provider wizard would be a worse dead end than the refusal
 * it replaced.
 */
export type RunModeSetupTarget = "cloud-provider" | "local-runtime";

/** Which legs `resolveRunMode` could not fill, as the panel mirrors them. */
export interface RunModeLegAvailability {
  cloudProviderMissing: boolean;
  localProviderMissing: boolean;
}

/**
 * What the operator has to configure before `mode` can run, or `null`
 * when the mode is ready to go.
 *
 * Fusion needs both legs and reports the cloud one first: without a
 * cloud orchestrator fusion cannot run at all, whereas a missing local
 * executor only makes it cloud-only. Fixing the fatal half first is also
 * the order the degradation sentences already use.
 */
export function runModeSetupTarget(
  mode: RunModeName,
  legs: RunModeLegAvailability,
): RunModeSetupTarget | null {
  if (mode === "local") return legs.localProviderMissing ? "local-runtime" : null;
  if (legs.cloudProviderMissing) return "cloud-provider";
  if (mode === "fusion" && legs.localProviderMissing) return "local-runtime";
  return null;
}

/**
 * The setup offer a run-mode surface should put in front of the
 * operator, given which mode the cursor is on.
 *
 * Wider than `runModeSetupTarget` on purpose. That one answers "can this
 * mode run", which is the only question a switch has to ask. A screen
 * has a second job: on a fresh install the cursor opens on Local — the
 * one mode that works — and a strictly-scoped offer would vanish exactly
 * where the dead end used to be. So the highlighted mode's own missing
 * leg wins, and failing that any missing leg keeps the way out visible.
 */
export function runModeSetupOffer(
  mode: RunModeName,
  legs: RunModeLegAvailability,
): RunModeSetupTarget | null {
  const forMode = runModeSetupTarget(mode, legs);
  if (forMode) return forMode;
  if (legs.cloudProviderMissing) return "cloud-provider";
  return legs.localProviderMissing ? "local-runtime" : null;
}

/**
 * Why the switch did not take, phrased for someone who is about to be
 * moved to the screen that fixes it.
 *
 * Deliberately not `describeRunModeDegradation`: that sentence ends by
 * telling the reader where to go ("Add one in Manage → LLM → Cloud"),
 * which is now stale advice — they are already being taken there. The
 * resolver's wording stays untouched for the CLI and HTTP surfaces,
 * which still only report.
 */
export function describeRunModeSetup(target: RunModeSetupTarget): string {
  return target === "cloud-provider"
    ? "No cloud provider is configured yet — opening Manage → LLM → Cloud so you can add one."
    : "No llama-server is configured yet — opening Manage → LLM → Local so you can set one up.";
}

/**
 * Leave whatever run-mode surface asked and land on the screen that can
 * fill the missing leg.
 *
 * One implementation for all three entry points (the `n` key, the
 * overlay's clickable row, and a mode switch that turned out to be
 * unconfigured) so the three gestures cannot drift into landing in
 * different places.
 *
 * `dispatch` here is genuinely a dispatch when the caller is a key
 * handler or the mouse layer, and `bus.emit` when the caller is the
 * orchestrator — the bus is bridged into the reducer, so an emitted
 * action arrives exactly as a dispatched one does.
 */
export function openRunModeSetup(
  dispatch: (action: TuiAction) => void,
  target: RunModeSetupTarget,
): void {
  dispatch({ type: "run_mode_picker_closed" });
  dispatch({ type: "ui_mode_set", mode: "debug" });
  dispatch({ type: "tab_changed", tab: "llm" });
  if (target === "local-runtime") {
    // The Local pane is already a setup checklist — backend, model,
    // daemon — so landing on it is the whole navigation. There is no
    // wizard to open, and opening one would hide the checklist.
    dispatch({ type: "llm_mode_set", mode: "local" });
    return;
  }
  dispatch({ type: "llm_mode_set", mode: "cloud" });
  dispatch({
    type: "providers_wizard_opened",
    wizard: createProvidersWizardState("add"),
  });
}
