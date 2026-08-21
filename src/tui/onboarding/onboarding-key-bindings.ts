import type { Key } from "ink";
import type { OnboardingAction } from "./onboarding-actions.js";
import {
  ONBOARDING_CHOICES,
  moveOnboardingCursor,
  stepOwnsItsKeyboard,
  type OnboardingUiState,
} from "./onboarding-state.js";

/**
 * What the host has to *do* about a key, as opposed to what the state
 * becomes. Persisting config and probing a URL are effects; keeping them
 * out of here is what lets the whole key table be unit-tested as data.
 */
export type OnboardingIntent =
  | { kind: "pick"; choice: "local" | "cloud" | "custom" }
  | { kind: "skip" };

export type OnboardingKeyResult =
  | { handled: false }
  | { handled: true; actions: readonly OnboardingAction[]; intent?: OnboardingIntent };

/**
 * Keys for the steps the flow draws itself. Steps that hand the keyboard
 * to a child (`cloud`, the URL editors) return `handled: false` for
 * everything, so the child's own `useInput` is the only reader.
 *
 * Ctrl+C is deliberately not claimed anywhere: quitting during setup
 * must keep working exactly as it does everywhere else.
 */
export function handleOnboardingKey(
  input: string,
  key: Key,
  onboarding: OnboardingUiState,
): OnboardingKeyResult {
  if (key.ctrl && input === "c") return { handled: false };
  if (stepOwnsItsKeyboard(onboarding.step)) return { handled: true, actions: [] };

  if (key.escape) {
    return { handled: true, actions: [], intent: { kind: "skip" } };
  }
  if (key.upArrow || input === "k") {
    return { handled: true, actions: [{ type: "onboarding_cursor_moved", delta: -1 }] };
  }
  if (key.downArrow || input === "j") {
    return { handled: true, actions: [{ type: "onboarding_cursor_moved", delta: 1 }] };
  }
  if (key.return) {
    const choice = ONBOARDING_CHOICES[onboarding.cursor];
    if (!choice) return { handled: true, actions: [] };
    return { handled: true, actions: [], intent: { kind: "pick", choice: choice.id } };
  }
  const digit = Number.parseInt(input, 10);
  if (Number.isInteger(digit) && digit >= 1 && digit <= ONBOARDING_CHOICES.length) {
    const choice = ONBOARDING_CHOICES[digit - 1]!;
    return {
      handled: true,
      actions: [{ type: "onboarding_cursor_set", cursor: digit - 1 }],
      intent: { kind: "pick", choice: choice.id },
    };
  }
  // Every other key is swallowed rather than falling through: while the
  // flow owns the screen there is nothing behind it for a key to reach.
  return { handled: true, actions: [] };
}

export { moveOnboardingCursor };
