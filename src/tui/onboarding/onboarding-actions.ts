import type {
  OnboardingHuggingFaceRepo,
  OnboardingOutcome,
  OnboardingStep,
  OnboardingUiState,
} from "./onboarding-state.js";

export type OnboardingAction =
  /** Open the flow (first run) — `null` closes it and hands over to the agent. */
  | { type: "onboarding_set"; onboarding: OnboardingUiState | null }
  | { type: "onboarding_step_set"; step: OnboardingStep }
  /**
   * `length` is the row count of the list being moved through — the
   * choice screen has three rows, the model picker has as many as the
   * catalog. Absent means the choice screen.
   */
  | { type: "onboarding_cursor_moved"; delta: number; length?: number }
  | { type: "onboarding_cursor_set"; cursor: number }
  | { type: "onboarding_url_changed"; field: "chat" | "embedding"; value: string }
  | { type: "onboarding_busy_set"; busy: boolean }
  | { type: "onboarding_error_set"; error: string | null }
  /** The local branch committed to a model and moved to the download. */
  | { type: "onboarding_local_model_picked"; modelId: string }
  /** Keystrokes in the Hugging Face reference editor. */
  | { type: "onboarding_hf_reference_changed"; value: string }
  /**
   * The repo answered. Carries the step change with it: resolving and
   * arriving on the file list are one event, and splitting them would
   * leave a frame showing an empty list under the old step's footer.
   */
  | { type: "onboarding_hf_repo_resolved"; repo: OnboardingHuggingFaceRepo }
  /** `c` on the download screen: set up cloud while the pull runs. */
  | { type: "onboarding_cloud_meanwhile_opened" }
  /** Offer the other backend once the first one works. */
  | { type: "onboarding_second_backend_offered"; offer: "local" | "cloud" }
  /** The flow reached its end; the host persists and closes it. */
  | {
      type: "onboarding_finished";
      outcome: OnboardingOutcome;
      /**
       * Go straight to the agent: the finished effect must not raise the
       * propose-second screen on the way out. Set by the download
       * screen's skip exit, whose own surface already made the cloud
       * pitch — see `handleDownloadKey`.
       */
      skipSecondOffer?: boolean;
    };
