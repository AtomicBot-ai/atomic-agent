import type {
  OnboardingOutcome,
  OnboardingStep,
  OnboardingUiState,
} from "./onboarding-state.js";

export type OnboardingAction =
  /** Open the flow (first run) — `null` closes it and hands over to the agent. */
  | { type: "onboarding_set"; onboarding: OnboardingUiState | null }
  | { type: "onboarding_step_set"; step: OnboardingStep }
  | { type: "onboarding_cursor_moved"; delta: number }
  | { type: "onboarding_cursor_set"; cursor: number }
  | { type: "onboarding_url_changed"; field: "chat" | "embedding"; value: string }
  | { type: "onboarding_busy_set"; busy: boolean }
  | { type: "onboarding_error_set"; error: string | null }
  /** The flow reached its end; the host persists and closes it. */
  | { type: "onboarding_finished"; outcome: OnboardingOutcome };
