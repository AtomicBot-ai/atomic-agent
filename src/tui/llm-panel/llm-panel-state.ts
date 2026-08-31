import type { ModelPricingFilter } from "../../llm/provider/model-pricing-filter.js";

/**
 * Panes of the LLM tab. `local` browses the managed llama.cpp catalog,
 * `cloud` the API providers, `external` the single base URL of a
 * llama-server the operator runs themselves, `fallback` the ordered
 * cross-provider fallover chain.
 */
export type LlmPanelMode = "local" | "cloud" | "external" | "fallback";

/** Left-to-right pane order, used by the ←/→ pane switch. */
export const LLM_PANEL_MODES: readonly LlmPanelMode[] = [
  "local",
  "cloud",
  "external",
  "fallback",
];

export type LlmPanelSection = LlmPanelMode;

export interface LlmStopLocalDaemonsPrompt {
  providerId: string;
}


export interface LlmPanelState {
  mode: LlmPanelMode;
  localCursor: number;
  cloudCursor: number;
  externalCursor: number;
  fallbackCursor: number;
  syncModeToActiveRoute: boolean;
  stopLocalDaemonsPrompt: LlmStopLocalDaemonsPrompt | null;
  /**
   * Buffer of the external base-URL editor. `null` when the editor is
   * closed — a non-null value (including `""`) means the modal owns the
   * keyboard.
   */
  externalUrlDraft: string | null;
  /**
   * URL of a refused External save whose probe answered `openai-compat`
   * (Ollama, LM Studio, vLLM…). Non-null opens the steer prompt: `y`
   * deep-links into the provider wizard prefilled with this URL instead
   * of leaving the operator at a dead-end verdict line.
   */
  externalCompatSteerUrl: string | null;
  /**
   * Typed filter of the Cloud pane's inline model list. Persists when
   * the filter row loses focus (Esc keeps the text, like the modal did).
   */
  cloudModelFilter: string;
  /**
   * True while the `filter:` row owns printable keys: typing edits the
   * filter, ↑/↓ still walk the filtered list, Esc unfocuses. Entered via
   * `f` or `/model`.
   */
  cloudModelFilterFocused: boolean;
  /**
   * Price facet of the Cloud pane's inline model list, cycled with `p`.
   * Own field rather than a term in `cloudModelFilter` so the two narrow
   * independently, and separate from the providers wizard's facet so
   * neither screen leaks its state into the other.
   */
  cloudModelPricing: ModelPricingFilter;
}

export function createInitialLlmPanelState(): LlmPanelState {
  return {
    mode: "local",
    localCursor: 0,
    cloudCursor: 0,
    externalCursor: 0,
    fallbackCursor: 0,
    syncModeToActiveRoute: false,
    stopLocalDaemonsPrompt: null,
    externalUrlDraft: null,
    externalCompatSteerUrl: null,
    cloudModelFilter: "",
    cloudModelFilterFocused: false,
    cloudModelPricing: "all",
  };
}

/** Which `LlmPanelState` cursor field belongs to a pane. */
export function cursorFieldFor(
  mode: LlmPanelMode,
): "localCursor" | "cloudCursor" | "externalCursor" | "fallbackCursor" {
  if (mode === "cloud") return "cloudCursor";
  if (mode === "external") return "externalCursor";
  if (mode === "fallback") return "fallbackCursor";
  return "localCursor";
}
