import { useInput } from "ink";
import type { OnboardingScreenCallbacks } from "../components/onboarding-screen.js";
import { handleOnboardingStepKey } from "../onboarding/onboarding-step-keys.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";

/**
 * Every key the first-run flow answers to. One `useInput` for the whole
 * flow: the step table lives in `onboarding-step-keys.ts`, in the
 * panels' `handle…(input, key, ctx)` shape, so `MouseListRow` +
 * `pressEnter` drive exactly the code the keyboard does — this hook is
 * only the keyboard's way in.
 *
 * Steps that hand the keyboard to a child return `false` in the router
 * and are ignored here: the cloud step's wizard editor, the URL and
 * Hugging Face reference editors. The splash is the other absentee: it
 * promises "press any key" and has to honour clicks, the wheel and
 * pastes too, so its input lives in `useIntroInput` beside the
 * surface-wide mouse target it needs.
 */
export function useOnboardingInputs(args: {
  state: TuiState;
  dispatch(action: TuiAction): void;
  callbacks: OnboardingScreenCallbacks;
}): void {
  const { state, dispatch, callbacks } = args;
  useInput((input, key) => {
    handleOnboardingStepKey(input, key, { state, dispatch, callbacks });
  });
}
