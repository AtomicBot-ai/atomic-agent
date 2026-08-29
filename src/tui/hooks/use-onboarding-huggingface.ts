import { useInput } from "ink";
import { useCallback, useEffect, useRef } from "react";

import { resolveHuggingFaceGgufChoices } from "../../local-llm/index.js";
import type { OnboardingUiState } from "../onboarding/onboarding-state.js";
import type { TuiAction } from "../tui-action.js";

/**
 * The effect behind the "add a model from Hugging Face" branch: asking
 * the repo what it holds. A hook rather than more body in
 * `OnboardingScreen` because it is a network write with a cancel path,
 * and the screen is already the longest module in the flow.
 *
 * The file list's keys — and the catalog write its Enter performs — live
 * in `onboarding-hf-keys.ts` with the rest of the flow's key table, so
 * the mouse and the keyboard share one activation path. What stays here
 * is what needs the lookup's AbortController: starting it, cancelling
 * it, and the clear affordance on the reference editor.
 */
export function useOnboardingHuggingFace(args: {
  onboarding: OnboardingUiState;
  dispatch(action: TuiAction): void;
}): { resolveReference(raw: string): void; clearReference(): void } {
  const { onboarding, dispatch } = args;

  /**
   * The lookup currently in flight, if any. Cancelling bumps past it by
   * replacing the ref's value, so a response that arrives afterwards
   * finds itself stale and dispatches nothing — the id comparison is
   * what makes esc trustworthy, the abort merely frees the socket.
   */
  const lookup = useRef<AbortController | null>(null);

  const cancelLookup = useCallback(() => {
    lookup.current?.abort();
    lookup.current = null;
  }, []);

  // An unmount mid-lookup (ctrl+c, flow closed) must not leave the
  // request holding a socket for up to 15 s.
  useEffect(() => cancelLookup, [cancelLookup]);

  /**
   * Every failure — a typo, a gated repo, a repo holding no GGUF at all
   * — comes back as a sentence and is shown on the editor that asked for
   * the reference, which is the only screen where retyping it is
   * possible.
   */
  const resolveReference = useCallback(
    (raw: string) => {
      if (onboarding.busy) return;
      const controller = new AbortController();
      lookup.current = controller;
      dispatch({ type: "onboarding_busy_set", busy: true });
      dispatch({ type: "onboarding_error_set", error: null });
      void resolveHuggingFaceGgufChoices(raw, { signal: controller.signal })
        .then((repo) => {
          if (lookup.current !== controller) return;
          lookup.current = null;
          // The reducer drops this when the flow has left `local_hf_ref`
          // — the stale-id check above covers cancel, the reducer's step
          // guard covers navigation this closure cannot see.
          dispatch({ type: "onboarding_hf_repo_resolved", repo });
        })
        .catch((err: unknown) => {
          if (lookup.current !== controller) return;
          lookup.current = null;
          dispatch({
            type: "onboarding_error_set",
            error: err instanceof Error ? err.message : String(err),
          });
          dispatch({ type: "onboarding_busy_set", busy: false });
        });
    },
    [dispatch, onboarding.busy],
  );

  /**
   * Empty the reference editor AND drop the error it earned: the error
   * describes the reference it stood under, and keeping it over an empty
   * editor would blame text that is no longer there. One function so the
   * ctrl+l chord and the `[ clear ]` click cannot come to mean different
   * things.
   */
  const clearReference = useCallback(() => {
    dispatch({ type: "onboarding_hf_reference_changed", value: "" });
    dispatch({ type: "onboarding_error_set", error: null });
  }, [dispatch]);

  // Ctrl+l, not ctrl+u: the editor binds ctrl+u to kill-to-line-start,
  // and Ink handlers do not consume — a screen-level ctrl+u would
  // double-fire against the focused editor. The editor ignores unknown
  // ctrl chords, so ctrl+l is this screen's alone. Gated exactly like
  // the on-screen control: nothing to clear, no key.
  useInput(
    (input, key) => {
      if (key.ctrl && input === "l") clearReference();
    },
    {
      isActive:
        onboarding.step === "local_hf_ref" &&
        !onboarding.busy &&
        onboarding.hfReference.length > 0,
    },
  );

  // While the lookup runs the reference editor is unfocused and the
  // app-level handler swallows everything, so without this reader the
  // operator has no key at all until the 15 s timeout — esc cancels and
  // hands the editor back with what they typed still in it.
  useInput(
    (_input, key) => {
      if (!key.escape) return;
      cancelLookup();
      dispatch({ type: "onboarding_busy_set", busy: false });
    },
    { isActive: onboarding.step === "local_hf_ref" && onboarding.busy },
  );

  return { resolveReference, clearReference };
}
