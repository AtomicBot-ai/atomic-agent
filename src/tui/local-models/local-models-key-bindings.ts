import type { Key } from "ink";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import {
  resolveRowAt,
  type EmbeddingModelRow,
  type LocalModelRow,
  type LocalModelsPanelState,
} from "./local-models-panel-state.js";

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

  // Memory-v2 phase 1B onboarding modal takes precedence over all
  // other keys — including the chat-remove modal — because it is
  // pushed automatically right after a chat-model pull succeeds, when
  // the operator has no other intent in flight.
  if (panel.embeddingOnboardingPrompt) {
    const lower = input.toLowerCase();
    if (lower === "y") {
      callbacks.onLocalModelsEmbeddingOnboardingResolved?.(true);
      return true;
    }
    if (lower === "n" || key.escape) {
      callbacks.onLocalModelsEmbeddingOnboardingResolved?.(false);
      return true;
    }
    return true;
  }

  // Two confirm modals (chat vs embedding) — keep them strictly
  // disjoint so a stray `y` in the chat modal can never delete an
  // embedding GGUF, and vice versa.
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
  if (panel.embeddingRemoveConfirmId) {
    const lower = input.toLowerCase();
    if (lower === "y") {
      callbacks.onLocalModelsEmbeddingRemoveConfirmed?.(
        panel.embeddingRemoveConfirmId,
      );
      dispatch({ type: "local_models_embedding_remove_confirm_closed" });
      return true;
    }
    if (lower === "n" || key.escape) {
      dispatch({ type: "local_models_embedding_remove_confirm_closed" });
      return true;
    }
    return true;
  }

  const ref = resolveRowAt(panel);

  if (panel.mode === "detail") {
    if (key.escape || input === "q") {
      dispatch({ type: "local_models_detail_closed" });
      return true;
    }
    if (key.return && ref?.kind === "chat") {
      triggerPrimaryAction(ref.row, panel, callbacks);
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

  // `E` (uppercase) toggles the embedding master switch. Kept on
  // shift to make the destructive-ish toggle deliberate; the cursor's
  // row type is intentionally NOT consulted — the operator may want
  // to flip the switch while parked on a chat row.
  if (input === "E") {
    callbacks.onLocalModelsEmbeddingToggleEnabledRequested?.();
    return true;
  }

  if (ref?.kind === "chat") {
    if (key.return) {
      triggerPrimaryAction(ref.row, panel, callbacks);
      return true;
    }
    if (input === "g") {
      triggerGgufOnlyPull(ref.row, callbacks);
      return true;
    }
    if (input === "i") {
      dispatch({ type: "local_models_mode_set", mode: "detail" });
      return true;
    }
    if (input === "d" && ref.row.downloaded) {
      dispatch({
        type: "local_models_remove_confirm_opened",
        id: ref.row.id,
      });
      return true;
    }
  } else if (ref?.kind === "embedding") {
    if (key.return) {
      triggerEmbeddingPrimaryAction(ref.row, panel, callbacks);
      return true;
    }
    if (input === "d" && ref.row.downloaded) {
      dispatch({
        type: "local_models_embedding_remove_confirm_opened",
        id: ref.row.id,
      });
      return true;
    }
  }

  if (input === "B") {
    callbacks.onLocalModelsBackendPullRequested?.();
    return true;
  }
  // `G` (uppercase) cycles the managed daemon's GPU preference. On shift
  // so it does not collide with the `g` GGUF-only pull on chat rows; the
  // cursor's row type is intentionally not consulted.
  if (input === "G") {
    callbacks.onLocalModelsDeviceCycleRequested?.();
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
 * - Already downloaded + active but daemon down → start chat daemon (`s`).
 */
function triggerPrimaryAction(
  row: LocalModelRow,
  panel: LocalModelsPanelState,
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
    return;
  }
  const chatUp =
    panel.daemon.running || panel.daemonPhase === "starting";
  if (!chatUp) {
    callbacks.onLocalModelsDaemonStartRequested?.();
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

/**
 * Memory-v2 phase 1B. Embedding-catalog Enter handler:
 * - Not downloaded → pull (orchestrator sets active + starts pairing when chat is up).
 * - Downloaded but not active → set active (+ pairing when chat is up).
 * - Already active (`*` prefix) but daemon down → enable/start embedding side.
 */
function triggerEmbeddingPrimaryAction(
  row: EmbeddingModelRow,
  panel: LocalModelsPanelState,
  callbacks: TuiAppCallbacks,
): void {
  if (!row.downloaded) {
    callbacks.onLocalModelsEmbeddingPullRequested?.(row.id);
    return;
  }
  if (!row.active) {
    callbacks.onLocalModelsEmbeddingSetActiveRequested?.(row.id);
    return;
  }
  const emb = panel.embeddingDaemon;
  if (!emb?.enabled) {
    callbacks.onLocalModelsEmbeddingToggleEnabledRequested?.();
    return;
  }
  const chatUp =
    panel.daemon.running || panel.daemonPhase === "starting";
  if (!chatUp) {
    callbacks.onLocalModelsDaemonStartRequested?.();
    return;
  }
  if (!emb.running) {
    callbacks.onLocalModelsEmbeddingStartRequested?.();
  }
}
