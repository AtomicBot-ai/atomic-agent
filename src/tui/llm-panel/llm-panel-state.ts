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

/** One search hit rendered as a numbered pick inside the prompt. */
export interface LlmHuggingFaceHit {
  repoId: string;
  downloads: number;
}

/**
 * "Add a model from Hugging Face…" prompt. One buffer serving two
 * intents: text that parses as a URL / `owner/name` is resolved and
 * added directly; anything else is treated as a search query and the
 * top hits come back in `results` for a digit pick. Keeping both on one
 * field avoids a mode toggle the operator would have to learn.
 */
export interface LlmHuggingFacePromptState {
  buffer: string;
  /** True while a network call is in flight; keys are ignored meanwhile. */
  busy: boolean;
  error: string | null;
  /** Populated when the last submit was a query rather than a reference. */
  results: readonly LlmHuggingFaceHit[];
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
  huggingFacePrompt: LlmHuggingFacePromptState | null;
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
    huggingFacePrompt: null,
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
