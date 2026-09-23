import { getConfig } from "../../config/index.js";
import { describeRunMode } from "../../llm/run-mode/index.js";
import { resolveFusionMachineFacts } from "../../prompt/fusion-machine-facts.js";
import {
  activateComposerSwitchRow,
  backendSwitchRow,
} from "../composer-switch/index.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import type { SlashDispatchResult } from "./slash-command-handler.js";

/**
 * `/runmode <mode>` activates the composer switch's own backend row for
 * that mode — the popup, the `ctrl+g 1/2/3` chords and the command all
 * share one activation path and one pre-flight. `/runmode status` reads
 * the resolver mirror the providers refresh keeps on the panel.
 */
export function runRunModeVerb(
  verb: NonNullable<SlashDispatchResult["runModeVerb"]>,
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
): void {
  if (verb === "status") {
    const rm = state.providersPanel.runMode;
    // What will run, not what the default is: the facts the model is
    // told, read from the config the way `buildPrompt` reads them. The
    // live slot count is the runtime's; here only the configured one.
    dispatch({
      type: "system_message",
      text: rm
        ? describeRunMode(rm, resolveFusionMachineFacts(getConfig()))
        : "run mode: not resolved yet — open Manage › LLM once",
    });
    return;
  }
  if (verb === "swap") {
    callbacks.onFusionLegsSwapRequested?.();
    return;
  }
  activateComposerSwitchRow(
    backendSwitchRow(state, verb),
    state,
    dispatch,
    callbacks,
  );
}
