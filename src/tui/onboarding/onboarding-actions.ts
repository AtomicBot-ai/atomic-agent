import type {
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
  /** The flow reached its end; the host persists and closes it. */
  | { type: "onboarding_finished"; outcome: OnboardingOutcome };
