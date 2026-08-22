import type { Key } from "ink";
import { addCustomModel } from "../../config/custom-models-store.js";
import { buildCustomModelDef } from "../../local-llm/index.js";
import type { OnboardingKeyContext } from "./onboarding-step-keys.js";
import type { OnboardingUiState } from "./onboarding-state.js";

/**
 * The Hugging Face file list's keys, in the same handler shape as the
 * rest of `onboarding-step-keys.ts` (which routes to this module — it is
 * split out only to keep that file inside the line budget). The Enter
 * branch carries the flow's one catalog write, so the mouse's
 * `pressEnter` and the keyboard land on the same effect.
 */
export function handleHfPickKey(
  input: string,
  key: Key,
  ctx: OnboardingKeyContext,
  onboarding: OnboardingUiState,
): boolean {
  if (key.escape) {
    ctx.dispatch({ type: "onboarding_step_set", step: "local_hf_ref" });
    return true;
  }
  if (key.upArrow || key.downArrow || input === "j" || input === "k") {
    ctx.dispatch({
      type: "onboarding_cursor_moved",
      delta: key.upArrow || input === "k" ? -1 : 1,
      length: onboarding.hfRepo?.choices.length ?? 0,
    });
    return true;
  }
  if (key.return) {
    startHuggingFacePull(ctx, onboarding);
    return true;
  }
  return false;
}

/**
 * Record the chosen file as a catalog entry, then hand it to the same
 * pull the curated rows use — which is what lands an added model on the
 * ordinary download screen rather than a second one built for it.
 */
function startHuggingFacePull(
  ctx: OnboardingKeyContext,
  onboarding: OnboardingUiState,
): void {
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
    // through the catalog registry, and the registry is loaded from the
    // file this call writes.
    addCustomModel(def);
    ctx.dispatch({ type: "onboarding_local_model_picked", modelId: def.id });
    ctx.callbacks.onLocalModelsPullRequested?.(def.id);
  } catch (err) {
    ctx.dispatch({
      type: "onboarding_error_set",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
