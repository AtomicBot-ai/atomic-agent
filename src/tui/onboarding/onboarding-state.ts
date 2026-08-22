import type {
  HuggingFaceFile,
  HuggingFaceGgufChoice,
} from "../../local-llm/index.js";

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
  /** Type a Hugging Face repo id or URL, for a model nobody curated. */
  | "local_hf_ref"
  /** Choose which GGUF in that repo to pull. */
  | "local_hf_pick"
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


/**
 * The screens a cloud wizard can be opened from while a pull is still
 * running: the download itself, and the "almost there" screen a first
 * cloud round-trip already led to. Adding a second provider from there
 * has to come back there, not to the download it never left.
 */
export type OnboardingCloudReturn = "local_download" | "wait_or_jump";

export interface OnboardingUiState {
  step: OnboardingStep;
  /** Which backend the "want the other too?" screen is offering. */
  offer: "local" | "cloud" | null;
  /**
   * The cloud wizard was opened *from* a running download, and this is
   * the screen it returns to. `null` when it was reached from the
   * backend choice, which is the one path that ends the flow instead.
   */
  resumeAfterCloud: OnboardingCloudReturn | null;
  /** The model being pulled, once the local branch has committed to one. */
  localModelId: string | null;
  /** Set together with the `finished` step; `null` at every other point. */
  outcome: OnboardingOutcome | null;
  /**
   * The finish asked to go straight to the agent — the finished effect
   * skips the propose-second offer. Carried on state rather than read
   * off the action because the effect runs a commit later, when the
   * action is gone; see `useOnboardingLifecycle` for why the bypass is
   * this flag and not a `proposedSecondBackendAt` stamp.
   */
  skipSecondOffer: boolean;
  /** Row cursor on the `choose` step. */
  cursor: number;
  chatUrl: string;
  embeddingUrl: string;
  /** A `/health` probe is in flight; the editor is read-only until it lands. */
  busy: boolean;
  error: string | null;
  /** What the operator typed on the Hugging Face step. */
  hfReference: string;
  /** The repo those choices came from; `null` before anything resolves. */
  hfRepo: OnboardingHuggingFaceRepo | null;
}

/**
 * A resolved Hugging Face repo and the GGUFs in it that this agent could
 * serve. Held on the flow's own slice rather than in the screen, so the
 * pick step is a pure render of state like every other step.
 */
export interface OnboardingHuggingFaceRepo {
  repoId: string;
  revision: string;
  choices: readonly HuggingFaceGgufChoice[];
  mmproj: HuggingFaceFile | null;
  /** One line naming the files that were filtered out, when any were. */
  hidden: string | null;
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
    resumeAfterCloud: null,
    outcome: null,
    skipSecondOffer: false,
    localModelId: null,
    cursor: 0,
    chatUrl,
    embeddingUrl: "",
    busy: false,
    error: null,
    hfReference: "",
    hfRepo: null,
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
  return step === "cloud" || step === "local_hf_ref" || step.startsWith("custom_");
}

/** Steps where the flow is over and the host is closing it down. */
export function isOnboardingSettled(state: OnboardingUiState): boolean {
  return state.step === "finished";
}
