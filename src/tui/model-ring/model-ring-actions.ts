import { resolveStateDir } from "../../config/index.js";
import { selectLocalRows } from "../llm-panel/llm-panel-row-builders.js";
import {
  stopLocalDaemonsForCloudSelection,
  triggerLlmPrimary,
} from "../llm-panel/llm-panel-primary-actions.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import {
  currentModelRingEntry,
  describeModelRing,
  formatModelRingEntry,
  LOCAL_RING_PROVIDER,
  MODEL_RING_MAX,
  nextModelRingEntry,
  sameModelRingEntry,
  toggleModelRingEntry,
  type ModelRingEntry,
} from "./model-ring.js";
import type { ModelRingCommand } from "./model-ring-command.js";
import { readModelRing, writeModelRing } from "./model-ring-store.js";

/**
 * `/model favorite …` and the ctrl+p switch (ATO-2169). Both end in the
 * paths the model pickers already use: a cloud entry goes through
 * `onProvidersSelectChatModel` (the Cloud pane's Enter), a local one
 * through `triggerLlmPrimary` on its Local pane row. Nothing here writes
 * config; the ring file is the only thing this feature owns.
 */

/** The agent state dir, where the ring file lives; resolved without reading config.json. */
function defaultStateDir(): string {
  return resolveStateDir();
}

/** The submit path runs this; the slash parser stays pure. */
export function runModelRingCommand(
  command: ModelRingCommand,
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  stateDir = defaultStateDir(),
): void {
  const say = (text: string): void => dispatch({ type: "system_message", text });
  const ring = readModelRing(stateDir);
  const current = currentModelRingEntry(state);
  if (command.kind === "list") {
    say(describeModelRing(ring, current));
    return;
  }
  if (command.kind === "clear") {
    say(writeModelRing(stateDir, []) ? "Favorite models cleared." : "Could not save the favorite models.");
    return;
  }
  const entry = command.entry ?? current;
  if (!entry) {
    say("The current model cannot be a favorite (Fusion, or your own llama.cpp server). Name one: /model favorite add <provider/model>.");
    return;
  }
  const has = ring.some((e) => sameModelRingEntry(e, entry));
  if (command.kind === "add" ? has : !has) {
    say(`${formatModelRingEntry(entry)} is ${has ? "already" : "not"} a favorite.\n${describeModelRing(ring, current)}`);
    return;
  }
  const next = toggleModelRingEntry(ring, entry);
  if (!writeModelRing(stateDir, next.ring)) {
    say("Could not save the favorite models.");
    return;
  }
  const full = command.kind === "add" && ring.length >= MODEL_RING_MAX ? ` (the oldest one made room; at most ${MODEL_RING_MAX})` : "";
  say(`${command.kind === "add" ? "Added" : "Removed"} ${formatModelRingEntry(entry)}${full}.\n${describeModelRing(next.ring, current)}`);
}

/**
 * ctrl+p: the next favourite becomes the chat model for the next turn,
 * and a composer notice names it with its place in the ring.
 */
export function cycleModelRing(
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
  stateDir = defaultStateDir(),
): void {
  const notice = (text: string): void => dispatch({ type: "composer_notice", text });
  const ring = readModelRing(stateDir);
  if (ring.length === 0) {
    notice("No favorite models yet: /model favorite add puts the current one in.");
    return;
  }
  if (state.providersPanel.runMode?.effective === "fusion") {
    notice("Favorite models do not switch under Fusion: /runmode cloud or local first.");
    return;
  }
  if (state.status === "running") {
    notice("Switch models after this turn.");
    return;
  }
  const next = nextModelRingEntry(ring, currentModelRingEntry(state));
  if (!next) return;
  const refused = switchToModelRingEntry(next.entry, state, dispatch, callbacks);
  const where = `${next.index + 1}/${ring.length}`;
  notice(refused ? `${formatModelRingEntry(next.entry)} (${where}): ${refused}` : `Model: ${formatModelRingEntry(next.entry)} (${where})`);
}

/** Switch to `entry`; the reason it cannot be, or null when the switch was sent. */
export function switchToModelRingEntry(
  entry: ModelRingEntry,
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
): string | null {
  if (entry.provider === LOCAL_RING_PROVIDER) {
    const row = selectLocalRows(state).find(
      (r) => r.kind === "localTextModel" && r.model.id === entry.model,
    );
    if (!row || row.kind !== "localTextModel" || !row.model.downloaded) {
      return "not downloaded on this computer";
    }
    triggerLlmPrimary(row, state, dispatch, callbacks);
    return null;
  }
  const provider = state.providersPanel.rows.find((p) => p.id === entry.provider);
  if (!provider || provider.kind === "llama-server") return "that provider is not set up";
  if (!provider.hasApiKey) return "that provider has no API key";
  callbacks.onProvidersSelectChatModel?.(entry.provider, entry.model);
  stopLocalDaemonsForCloudSelection(state, callbacks);
  return null;
}
