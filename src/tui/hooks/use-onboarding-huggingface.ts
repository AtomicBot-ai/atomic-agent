import { useInput } from "ink";
import { useCallback } from "react";

import { addCustomModel } from "../../config/custom-models-store.js";
import {
  buildCustomModelDef,
  resolveHuggingFaceGgufChoices,
  type LocalModelId,
} from "../../local-llm/index.js";
import type { OnboardingUiState } from "../onboarding/onboarding-state.js";
import type { TuiAction } from "../tui-action.js";

/**
 * The two effects behind the "add a model from Hugging Face" branch:
 * asking the repo what it holds, and turning the chosen file into a
 * catalog entry the ordinary pull can take.
 *
 * A hook rather than more body in `OnboardingScreen` because both are
 * writes — one to the network, one to the user config — and the screen
 * is already the longest module in the flow. The file-list keys live
 * here too, so the whole branch is one thing to read.
 */
export function useOnboardingHuggingFace(args: {
  onboarding: OnboardingUiState;
  dispatch(action: TuiAction): void;
  onPullRequested?(modelId: LocalModelId): void;
}): { resolveReference(raw: string): void } {
  const { onboarding, dispatch, onPullRequested } = args;
  const choiceCount = onboarding.hfRepo?.choices.length ?? 0;

  /**
   * Every failure — a typo, a gated repo, a repo holding no GGUF at all
   * — comes back as a sentence and is shown on the editor that asked for
   * the reference, which is the only screen where retyping it is
   * possible.
   */
  const resolveReference = useCallback(
    (raw: string) => {
      if (onboarding.busy) return;
      dispatch({ type: "onboarding_busy_set", busy: true });
      dispatch({ type: "onboarding_error_set", error: null });
      void resolveHuggingFaceGgufChoices(raw)
        .then((repo) => dispatch({ type: "onboarding_hf_repo_resolved", repo }))
        .catch((err: unknown) => {
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
   * Record the chosen file as a catalog entry, then hand it to the same
   * pull the curated rows use — which is what lands an added model on
   * the ordinary download screen rather than a second one built for it.
   */
  const startPull = useCallback(() => {
    const repo = onboarding.hfRepo;
    if (!repo || repo.choices.length === 0) return;
    const choice = repo.choices[onboarding.cursor % repo.choices.length];
    if (!choice) return;
    try {
      const def = buildCustomModelDef({
        repoId: repo.repoId,
        revision: repo.revision,
        file: { path: choice.path, sizeBytes: choice.sizeBytes },
        mmproj: repo.mmproj,
      });
      // Written before the pull starts: `pullModel` resolves the id
      // through the catalog registry, and the registry is loaded from
      // the file this call writes.
      addCustomModel(def);
      dispatch({ type: "onboarding_local_model_picked", modelId: def.id });
      onPullRequested?.(def.id);
    } catch (err) {
      dispatch({
        type: "onboarding_error_set",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [dispatch, onPullRequested, onboarding.cursor, onboarding.hfRepo]);

  useInput(
    (input, key) => {
      if (key.escape) {
        dispatch({ type: "onboarding_step_set", step: "local_hf_ref" });
        return;
      }
      if (key.upArrow || key.downArrow || input === "j" || input === "k") {
        dispatch({
          type: "onboarding_cursor_moved",
          delta: key.upArrow || input === "k" ? -1 : 1,
          length: choiceCount,
        });
        return;
      }
      if (key.return) startPull();
    },
    { isActive: onboarding.step === "local_hf_pick" },
  );

  return { resolveReference };
}
