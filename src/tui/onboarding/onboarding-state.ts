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
  | "intro"
  | "choose"
  | "local_pick"
  | "local_download"
  | "cloud"
  | "custom_chat_url"
  | "custom_embedding_url"
  | "propose_second"
  | "wait_or_jump"
  | "finished";

/**
 * How the flow ended. The host reads it once, on the `finished` step, to
 * decide what to persist and where to hand over — keeping that decision
 * out of the reducer, which cannot write files.
 */
export type OnboardingOutcome = "local" | "cloud" | "custom" | "skipped";

export interface OnboardingUiState {
  step: OnboardingStep;
  /** Which backend the "want the other too?" screen is offering. */
  offer: "local" | "cloud" | null;
  /**
   * The cloud wizard was opened *from* a running download, so finishing
   * it returns to the download rather than to the agent.
   */
  resumeAfterCloud: boolean;
  /** The model being pulled, once the local branch has committed to one. */
  localModelId: string | null;
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
  /**
   * Two lines, wrapped by hand rather than by Ink. The trade-off each
   * backend asks the operator to make — privacy, money, time — is the
   * thing they are actually choosing between, so it is on the screen
   * instead of behind it.
   */
  readonly detail: readonly [string, string];
}

/**
 * Row order is load-bearing: the digit shortcuts are positional, and the
 * order is asserted by tests so a reshuffle cannot silently remap `1`.
 */
export const ONBOARDING_CHOICES: readonly OnboardingChoice[] = [
  {
    id: "local",
    label: "Local models",
    detail: [
      "llama.cpp on this machine. Private, free per token,",
      "one download of 2.7–22 GB.",
    ],
  },
  {
    id: "cloud",
    label: "Cloud models",
    detail: [
      "OpenRouter, Anthropic, Gemini, Groq and 20 more.",
      "Fastest to a working agent — needs an API key.",
    ],
  },
  {
    id: "custom",
    label: "Custom endpoint",
    detail: [
      "An OpenAI-compatible or llama-server URL you already run.",
      "Nothing is downloaded, nothing else is asked.",
    ],
  },
];

export function createOnboardingState(chatUrl: string): OnboardingUiState {
  return {
    step: "intro",
    offer: null,
    resumeAfterCloud: false,
    outcome: null,
    localModelId: null,
    cursor: 0,
    chatUrl,
    embeddingUrl: "",
    busy: false,
    error: null,
  };
}

/** Wrapping row movement, over any list length. */
export function moveOnboardingCursor(
  cursor: number,
  delta: number,
  length: number = ONBOARDING_CHOICES.length,
): number {
  const count = Math.max(1, length);
  return (((cursor + delta) % count) + count) % count;
}

/**
 * Whether the step draws its own input. The cloud step hands the
 * keyboard to the providers wizard and the URL steps to the line
 * editor, both of which subscribe to `useInput` themselves — the
 * app-level handler must not act on those keys as well, or every
 * keystroke is processed twice.
 */
export function stepOwnsItsKeyboard(step: OnboardingStep): boolean {
  return step === "cloud" || step.startsWith("custom_");
}

/** Steps where the flow is over and the host is closing it down. */
export function isOnboardingSettled(state: OnboardingUiState): boolean {
  return state.step === "finished";
}
