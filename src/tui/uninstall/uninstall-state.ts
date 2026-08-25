/**
 * One row of the "what will go" list, already formatted. The modal is
 * presentation only, so the sizes are turned into strings here where a
 * test can read them.
 */
export interface UninstallPreviewRow {
  readonly path: string;
  readonly label: string;
  readonly size: string;
  readonly group: "data" | "program";
}

export interface UninstallPreview {
  readonly rows: readonly UninstallPreviewRow[];
  readonly total: string;
  /** True when a dev checkout means only data is listed. */
  readonly devCheckout: boolean;
}

/**
 * Where the operator is in the ladder.
 *
 * `review` shows what goes and asks whether to continue; `confirm` makes
 * them type the word. Two screens rather than one because the first is
 * about *what* and the second is about *whether*, and a dialog that asks
 * both at once gets answered as if it only asked the first.
 *
 * `closing` is the last frame the TUI draws. Nothing is deleted while
 * the app is up: the removal runs after Ink unmounts and the runtime
 * has closed its SQLite handles and stopped llama-server, in the same
 * post-exit slot the self-update restart uses. Deleting the state
 * directory out from under a live runtime is how you get a half-written
 * WAL and a directory that reappears a second after you removed it.
 */
export type UninstallStep =
  | "loading"
  | "review"
  | "confirm"
  | "closing"
  | "failed";

export interface UninstallFlowState {
  readonly step: UninstallStep;
  readonly preview: UninstallPreview | null;
  /** What has been typed on the `confirm` step. */
  readonly typed: string;
  /** Focused button on `review`. Starts on `cancel`, always. */
  readonly cursor: "continue" | "cancel";
  /** Populated on `failed`: the plan could not be built. */
  readonly errors: readonly string[];
}

/**
 * The word that has to be typed out. Not a `y`, and not the app's name
 * either: `atomic-agent` is what an operator types twenty times a day,
 * and the point of this field is a word that no reflex reaches for.
 */
export const UNINSTALL_CONFIRM_WORD = "uninstall";

export function initialUninstallFlow(): UninstallFlowState {
  return {
    step: "loading",
    preview: null,
    typed: "",
    cursor: "cancel",
    errors: [],
  };
}

/** Whether what has been typed unlocks the final key. Case-insensitive. */
export function isUninstallConfirmed(typed: string): boolean {
  return typed.trim().toLowerCase() === UNINSTALL_CONFIRM_WORD;
}
