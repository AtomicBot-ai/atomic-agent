/**
 * Panes of the LLM tab. `local` browses the managed llama.cpp catalog,
 * `cloud` the API providers, `external` the single base URL of a
 * llama-server the operator runs themselves.
 */
export type LlmPanelMode = "local" | "cloud" | "external";

/** Left-to-right pane order, used by the ←/→ pane switch. */
export const LLM_PANEL_MODES: readonly LlmPanelMode[] = ["local", "cloud", "external"];

export type LlmPanelSection = LlmPanelMode;

export interface LlmStopLocalDaemonsPrompt {
  providerId: string;
}


export interface LlmPanelState {
  mode: LlmPanelMode;
  localCursor: number;
  cloudCursor: number;
  externalCursor: number;
  syncModeToActiveRoute: boolean;
  stopLocalDaemonsPrompt: LlmStopLocalDaemonsPrompt | null;
  /**
   * Buffer of the external base-URL editor. `null` when the editor is
   * closed — a non-null value (including `""`) means the modal owns the
   * keyboard.
   */
  externalUrlDraft: string | null;
}

export function createInitialLlmPanelState(): LlmPanelState {
  return {
    mode: "local",
    localCursor: 0,
    cloudCursor: 0,
    externalCursor: 0,
    syncModeToActiveRoute: false,
    stopLocalDaemonsPrompt: null,
    externalUrlDraft: null,
  };
}

/** Which `LlmPanelState` cursor field belongs to a pane. */
export function cursorFieldFor(
  mode: LlmPanelMode,
): "localCursor" | "cloudCursor" | "externalCursor" {
  if (mode === "cloud") return "cloudCursor";
  if (mode === "external") return "externalCursor";
  return "localCursor";
}
