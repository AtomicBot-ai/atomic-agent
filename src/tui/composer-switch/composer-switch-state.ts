/**
 * The composer meta row is three controls, not one label: the backend
 * kind, the provider and the model. Each opens a switch — a small
 * overlay listing what that element can be changed to.
 *
 * The row reads left to right in the order the route is decided:
 * *where* the model runs, *who* serves it, *which* one. Opening a switch
 * parks the choice in `TuiState.composerSwitch`; ←/→ walk the three
 * without closing, which is what makes the row behave like one control
 * strip rather than three unrelated popups.
 */
export type ComposerSwitchKind = "backend" | "provider" | "model";

/** Left-to-right order of the controls, and of the ←/→ walk. */
export const COMPOSER_SWITCH_KINDS: readonly ComposerSwitchKind[] = [
  "backend",
  "provider",
  "model",
];

/**
 * Where the chat route runs.
 *
 * `cloud` is a key-based API provider. `local` and `custom` are both the
 * `local-llama` provider — they are told apart by `localModels.mode`,
 * which is `managed` for the llama.cpp this app downloads and runs, and
 * `external` for one the operator runs themselves at their own base URL.
 * There is no third provider kind behind `custom`: the config models it
 * as a mode of the local backend, and the switch says the same thing.
 */
export type ComposerBackendKind = "cloud" | "local" | "custom";

export interface ComposerSwitchState {
  readonly kind: ComposerSwitchKind;
  /** Index among the rows of `kind`, clamped by the selectors. */
  readonly cursor: number;
  /**
   * Substring filter typed straight into the open switch. Lives here
   * rather than in a panel slice because it means nothing once the
   * popup closes — the model switch lists 300+ catalog rows in a
   * ten-row window, and typing is the only sane way across them.
   */
  readonly filter: string;
}

/** Title drawn on the popup, and the word the control itself reads as. */
export const COMPOSER_SWITCH_TITLES: Record<ComposerSwitchKind, string> = {
  backend: "Where it runs",
  provider: "Provider",
  model: "Model",
};

/** Step `delta` controls along the row, clamped at both ends. */
export function neighbourSwitchKind(
  kind: ComposerSwitchKind,
  delta: number,
): ComposerSwitchKind {
  const at = COMPOSER_SWITCH_KINDS.indexOf(kind);
  const next = Math.min(
    COMPOSER_SWITCH_KINDS.length - 1,
    Math.max(0, at + delta),
  );
  return COMPOSER_SWITCH_KINDS[next] ?? kind;
}
