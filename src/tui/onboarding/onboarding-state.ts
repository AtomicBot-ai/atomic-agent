/**
 * First-run flow state. Lives on `TuiState.onboarding` and is `null`
 * whenever the flow is not on screen, which is also the render switch:
 * a non-null value means the onboarding surface owns the whole terminal
 * — no status bar, no rail, no composer, no hint strip but its own.
 *
 * A separate slice rather than a third `TuiUiMode`: twenty-one modules
 * branch on `uiMode`, and a new variant would have to be considered in
 * every one of them. Nothing branches on a slice it does not read.
 */
export type OnboardingStep =
  | "choose"
  | "cloud"
  | "custom_chat_url"
  | "custom_embedding_url"
  | "finished";

/**
 * How the flow ended. The host reads it once, on the `finished` step, to
 * decide what to persist and where to hand over — keeping that decision
 * out of the reducer, which cannot write files.
 */
export type OnboardingOutcome = "local" | "cloud" | "custom" | "skipped";

export interface OnboardingUiState {
  step: OnboardingStep;
  /** Set together with the `finished` step; `null` at every other point. */
  outcome: OnboardingOutcome | null;
  /** Row cursor on the `choose` step. */
  cursor: number;
  chatUrl: string;
  embeddingUrl: string;
  /** A `/health` probe is in flight; the editor is read-only until it lands. */
  busy: boolean;
  error: string | null;
}

export interface OnboardingChoice {
  readonly id: "local" | "cloud" | "custom";
  readonly label: string;
  readonly detail: string;
}

/**
 * Row order is load-bearing: the digit shortcuts are positional, and the
 * order is asserted by tests so a reshuffle cannot silently remap `1`.
 */
export const ONBOARDING_CHOICES: readonly OnboardingChoice[] = [
  {
    id: "local",
    label: "Local models",
    detail: "llama.cpp on this machine — download and run locally",
  },
  {
    id: "cloud",
    label: "Cloud models",
    detail: "configure an API key and pick a model",
  },
  {
    id: "custom",
    label: "Custom endpoint",
    detail: "an existing llama-server URL you already run",
  },
];

export function createOnboardingState(chatUrl: string): OnboardingUiState {
  return {
    step: "choose",
    outcome: null,
    cursor: 0,
    chatUrl,
    embeddingUrl: "",
    busy: false,
    error: null,
  };
}

/** Wrapping row movement on the `choose` step. */
export function moveOnboardingCursor(cursor: number, delta: number): number {
  const count = ONBOARDING_CHOICES.length;
  return (cursor + delta + count) % count;
}

/**
 * Whether the step draws its own input. The cloud step hands the
 * keyboard to the providers wizard and the URL steps to the line
 * editor, both of which subscribe to `useInput` themselves — the
 * app-level handler must not act on those keys as well, or every
 * keystroke is processed twice.
 */
export function stepOwnsItsKeyboard(step: OnboardingStep): boolean {
  return step !== "choose";
}

/** Steps where the flow is over and the host is closing it down. */
export function isOnboardingSettled(state: OnboardingUiState): boolean {
  return state.step === "finished";
}
