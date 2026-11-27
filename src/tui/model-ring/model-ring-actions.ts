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
  type ModelRingDirection,
  type ModelRingEntry,
  type ModelRingState,
} from "./model-ring.js";
import type { ModelRingCommand } from "./model-ring-command.js";
import { readModelRing, writeModelRing } from "./model-ring-store.js";

/**
 * `/model favorite …` and the ctrl+p / alt+p switch (ATO-2169, ATO-2500). Both end in the
 * paths the model pickers already use: a cloud entry goes through
 * `onProvidersSelectChatModel` (the Cloud pane's Enter), a local one
 * through `triggerLlmPrimary` on its Local pane row. Nothing here writes
 * config; the ring file is the only thing this feature owns.
 */

/** The agent state dir, where the ring file lives; resolved without reading config.json. */
function defaultStateDir(): string {
  return resolveStateDir();
}

/**
 * The ring this session works on (ATO-2500): the `--models` list when the
 * TUI was started with one, else the shared file, read now, because the
 * desktop may have starred a model since the last read.
 */
export function loadModelRing(state: TuiState, stateDir = defaultStateDir()): ModelRingState {
  if (state.modelRing?.sessionOnly) return state.modelRing;
  return { entries: readModelRing(stateDir), sessionOnly: false };
}

/** A `--models` ring changes for this session only; the shared file is left alone. */
function saveModelRing(ring: ModelRingState, next: readonly ModelRingEntry[], stateDir: string): boolean {
  return ring.sessionOnly || writeModelRing(stateDir, next);
}

const SESSION_ONLY_NOTE = "\nThis session uses the --models list: changes last until you quit and are not saved.";

/** The submit path runs this; the slash parser stays pure. */
export function runModelRingCommand(
  command: ModelRingCommand,
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  stateDir = defaultStateDir(),
): void {
  const ring = loadModelRing(state, stateDir);
  const note = ring.sessionOnly ? SESSION_ONLY_NOTE : "";
  const say = (text: string): void => dispatch({ type: "system_message", text: `${text}${note}` });
  const loaded = (entries: readonly ModelRingEntry[]): void =>
    dispatch({ type: "model_ring_loaded", ring: { entries: [...entries], sessionOnly: ring.sessionOnly } });
  const current = currentModelRingEntry(state);
  if (command.kind === "list") {
    loaded(ring.entries);
    say(describeModelRing(ring.entries, current));
    return;
  }
  if (command.kind === "clear") {
    if (!saveModelRing(ring, [], stateDir)) {
      say("Could not save the favorite models.");
      return;
    }
    loaded([]);
    say("Favorite models cleared.");
    return;
  }
  const entry = command.entry ?? current;
  if (!entry) {
    say("The current model cannot be a favorite (Fusion, or your own llama.cpp server). Name one: /model favorite add <provider/model>.");
    return;
  }
  const has = ring.entries.some((e) => sameModelRingEntry(e, entry));
  if (command.kind === "add" ? has : !has) {
    say(`${formatModelRingEntry(entry)} is ${has ? "already" : "not"} a favorite.\n${describeModelRing(ring.entries, current)}`);
    return;
  }
  const next = toggleModelRingEntry(ring.entries, entry);
  if (!saveModelRing(ring, next.ring, stateDir)) {
    say("Could not save the favorite models.");
    return;
  }
  loaded(next.ring);
  const full = command.kind === "add" && ring.entries.length >= MODEL_RING_MAX ? ` (the oldest one made room; at most ${MODEL_RING_MAX})` : "";
  say(`${command.kind === "add" ? "Added" : "Removed"} ${formatModelRingEntry(entry)}${full}.\n${describeModelRing(next.ring, current)}`);
}

/**
 * ctrl+p (and, with `direction` -1, alt+p or ctrl+shift+p): the next (or
 * previous) favourite becomes the chat model for the next turn, and a
 * composer notice names it with its place in the ring.
 */
export function cycleModelRing(
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  callbacks: TuiAppCallbacks,
  stateDir = defaultStateDir(),
  direction: ModelRingDirection = 1,
): void {
  const notice = (text: string): void => dispatch({ type: "composer_notice", text });
  const ring = loadModelRing(state, stateDir);
  // The bar's `fav n/m` follows a list the desktop changed since the last read.
  if (!ring.sessionOnly) dispatch({ type: "model_ring_loaded", ring });
  if (ring.entries.length === 0) {
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
  const next = nextModelRingEntry(ring.entries, currentModelRingEntry(state), direction);
  if (!next) return;
  const refused = switchToModelRingEntry(next.entry, state, dispatch, callbacks);
  const where = `${next.index + 1}/${ring.entries.length}`;
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
