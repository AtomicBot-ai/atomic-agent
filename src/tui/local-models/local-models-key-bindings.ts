import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import type { LocalModelRow } from "./local-models-panel-state.js";

export interface LocalModelsTabKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

export function handleLocalModelsTabKey(
  input: string,
  key: Key,
  ctx: LocalModelsTabKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  if (state.uiMode !== "debug" || state.activeTab !== "models") return false;
  const panel = state.localModelsPanel;
  const row = panel.rows[panel.cursor];

  if (panel.removeConfirmId) {
    const lower = input.toLowerCase();
    if (lower === "y") {
      callbacks.onLocalModelsRemoveConfirmed?.(panel.removeConfirmId);
      dispatch({ type: "local_models_remove_confirm_closed" });
      return true;
    }
    if (lower === "n" || key.escape) {
      dispatch({ type: "local_models_remove_confirm_closed" });
      return true;
    }
    return true;
  }

  if (panel.mode === "detail") {
    if (key.escape || input === "q") {
      dispatch({ type: "local_models_detail_closed" });
      return true;
    }
    if (key.return && row) {
      triggerPrimaryAction(row, callbacks);
      dispatch({ type: "local_models_detail_closed" });
      return true;
    }
    return false;
  }

  if (panel.mode === "backendUpdate") {
    return true;
  }

  if (key.escape) return false;

  if (key.downArrow || input === "j") {
    dispatch({ type: "local_models_cursor_down" });
    return true;
  }
  if (key.upArrow || input === "k") {
    dispatch({ type: "local_models_cursor_up" });
    return true;
  }
  if (key.return && row) {
    triggerPrimaryAction(row, callbacks);
    return true;
  }
  if (input === "g" && row) {
    triggerGgufOnlyPull(row, callbacks);
    return true;
  }
  if (input === "i" && row) {
    dispatch({ type: "local_models_mode_set", mode: "detail" });
    return true;
  }
  if (input === "d" && row?.downloaded) {
    dispatch({ type: "local_models_remove_confirm_opened", id: row.id });
    return true;
  }
  if (input === "B") {
    callbacks.onLocalModelsBackendPullRequested?.();
    return true;
  }
  if (input === "r") {
    callbacks.onLocalModelsRefreshRequested?.();
    return true;
  }
  if (input === "s") {
    const running = panel.daemon.running || panel.daemonPhase === "starting";
    if (running) {
      callbacks.onLocalModelsDaemonStopRequested?.();
    } else {
      callbacks.onLocalModelsDaemonStartRequested?.();
    }
    return true;
  }
  if (input === "L") {
    dispatch({ type: "tab_changed", tab: "llm-logs" });
    return true;
  }
  return false;
}

/**
 * Enter picks the next obvious action for the row, taking mmproj
 * status into account so vision-capable models land in a usable state:
 * - GGUF missing → pull GGUF (+ mmproj for vision-capable rows).
 * - GGUF present, mmproj missing on a vision-capable row → pull
 *   mmproj only. The operator must restart the daemon with `--mmproj`
 *   afterwards; the orchestrator emits a hint.
 * - GGUF present (text-only OR mmproj also present) but row not active
 *   → set the row as the active managed model.
 * - Already downloaded + active → no-op (operator should run
 *   `llama start` if the daemon is not yet up).
 */
function triggerPrimaryAction(
  row: LocalModelRow,
  callbacks: TuiAppCallbacks,
): void {
  if (!row.downloaded) {
    callbacks.onLocalModelsPullRequested?.(row.id, "with-mmproj");
    return;
  }
  if (row.mmprojStatus === "missing") {
    callbacks.onLocalModelsPullRequested?.(row.id, "mmproj-only");
    return;
  }
  if (!row.active) {
    callbacks.onLocalModelsSetActiveRequested?.(row.id);
  }
}

/**
 * `g` hotkey: GGUF-only pull, even for vision-capable rows. Used when
 * the operator wants a fast text smoke test before paying for the
 * mmproj download. No-op on rows whose GGUF is already present —
 * Enter is the right key for "fill in what's missing".
 */
function triggerGgufOnlyPull(
  row: LocalModelRow,
  callbacks: TuiAppCallbacks,
): void {
  if (row.downloaded) return;
  callbacks.onLocalModelsPullRequested?.(row.id, "gguf-only");
}
