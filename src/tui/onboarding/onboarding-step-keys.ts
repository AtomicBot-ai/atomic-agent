import type { Key } from "ink";
import type { LocalModelId } from "../../local-llm/index.js";
import type { OnboardingScreenCallbacks } from "../components/onboarding-screen.js";
import {
  waitOrJumpPullStatus,
  waitOrJumpRowCount,
} from "../components/onboarding-wait-or-jump-step.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { routeProvidersWizardKey } from "../providers/route-wizard-key.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import {
  buildLocalModelPicks,
  buildLocalPickRows,
  hostRamGb,
  orderLocalModelPicks,
  type LocalPickRow,
} from "./local-model-picks.js";
import { handleHfPickKey } from "./onboarding-hf-keys.js";
import { handleOnboardingKey } from "./onboarding-key-bindings.js";
import type { OnboardingUiState } from "./onboarding-state.js";

/**
 * The first-run flow's keys in the panels' handler shape —
 * `handle…(input, key, ctx) → boolean` — so `MouseListRow` +
 * `pressEnter` can drive exactly the code the keyboard does. These used
 * to live inline in `useOnboardingInputs`'s per-step `useInput` blocks,
 * where no click could reach them; the hook now calls this router and so
 * does every mouse gesture, which is what keeps the two from drifting.
 *
 * Not pure — the choose step's Enter persists config and the Hugging
 * Face pick writes a catalog entry — but that is the panel handlers'
 * precedent: effects ride along, state changes funnel through dispatch.
 */
export interface OnboardingKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: OnboardingScreenCallbacks;
}

/**
 * The curated picks plus the trailing Hugging Face row, rebuilt from the
 * host's RAM on each call. Derived here rather than passed in so a click
 * handler — which owns no props — resolves the same rows the frame drew;
 * the inputs are a syscall and a fixed catalog, so the rebuild is cheap
 * and cannot disagree with the render's own derivation.
 */
export function onboardingPickRows(): readonly LocalPickRow[] {
  return buildLocalPickRows(orderLocalModelPicks(buildLocalModelPicks(hostRamGb())));
}

/**
 * Route one key to the current step. Returns `true` when the step
 * consumed it. Steps that hand the keyboard to a child (`cloud` goes to
 * the wizard below, the URL/HF editors own theirs) return `false` here
 * for everything the child should see; the splash keeps its own reader
 * in `useIntroInput` because its two-stage advance lives in a ref there.
 */
export function handleOnboardingStepKey(
  input: string,
  key: Key,
  ctx: OnboardingKeyContext,
): boolean {
  const onboarding = ctx.state.onboarding;
  if (!onboarding) return false;
  switch (onboarding.step) {
    case "choose":
      return handleChooseKey(input, key, ctx, onboarding);
    case "local_pick":
      return handleLocalPickKey(input, key, ctx, onboarding);
    case "local_hf_pick":
      return handleHfPickKey(input, key, ctx, onboarding);
    case "local_download":
      return handleDownloadKey(input, key, ctx);
    case "wait_or_jump":
      return handleWaitOrJumpKey(input, key, ctx, onboarding);
    case "propose_second":
      return handleProposeKey(input, key, ctx, onboarding);
    case "cloud":
      return handleCloudKey(input, key, ctx);
    default:
      return false;
  }
}

/** Open the chosen backend's branch — the choose step's Enter. */
function pickBackend(
  choice: "local" | "cloud" | "custom",
  ctx: OnboardingKeyContext,
): void {
  if (choice === "cloud") {
    ctx.dispatch({
      type: "providers_wizard_opened",
      wizard: createProvidersWizardState("add"),
    });
    ctx.dispatch({ type: "onboarding_step_set", step: "cloud" });
    return;
  }
  if (choice === "custom") {
    ctx.dispatch({ type: "onboarding_step_set", step: "custom_chat_url" });
    return;
  }
  // Managed mode is recorded now so a Ctrl+C mid-download does not
  // lose the choice; the model id follows when the pull completes.
  persistUserLocalModelsConfig({ mode: "managed" });
  ctx.dispatch({ type: "onboarding_step_set", step: "local_pick" });
}

function handleChooseKey(
  input: string,
  key: Key,
  ctx: OnboardingKeyContext,
  onboarding: OnboardingUiState,
): boolean {
  const result = handleOnboardingKey(input, key, onboarding);
  if (!result.handled) return false;
  for (const action of result.actions) ctx.dispatch(action);
  const intent = result.intent;
  if (!intent || intent.kind === "intro_key") return true;
  if (intent.kind === "skip") {
    ctx.dispatch({ type: "onboarding_finished", outcome: "skipped" });
    return true;
  }
  pickBackend(intent.choice, ctx);
  return true;
}

function handleLocalPickKey(
  input: string,
  key: Key,
  ctx: OnboardingKeyContext,
  onboarding: OnboardingUiState,
): boolean {
  const pickRows = onboardingPickRows();
  if (key.escape) {
    ctx.dispatch({ type: "onboarding_step_set", step: "choose" });
    return true;
  }
  if (key.upArrow || input === "k") {
    ctx.dispatch({ type: "onboarding_cursor_moved", delta: -1, length: pickRows.length });
    return true;
  }
  if (key.downArrow || input === "j") {
    ctx.dispatch({ type: "onboarding_cursor_moved", delta: 1, length: pickRows.length });
    return true;
  }
  if (key.return) {
    const row = pickRows[onboarding.cursor % Math.max(1, pickRows.length)];
    if (!row) return true;
    if (row.kind === "hugging_face") {
      ctx.dispatch({ type: "onboarding_step_set", step: "local_hf_ref" });
      return true;
    }
    ctx.dispatch({ type: "onboarding_local_model_picked", modelId: row.pick.id });
    ctx.callbacks.onLocalModelsPullRequested?.(row.pick.id as LocalModelId);
    return true;
  }
  return false;
}

function handleDownloadKey(
  input: string,
  key: Key,
  ctx: OnboardingKeyContext,
): boolean {
  if (input === "c" && !key.ctrl) {
    ctx.dispatch({
      type: "providers_wizard_opened",
      wizard: createProvidersWizardState("add"),
    });
    ctx.dispatch({ type: "onboarding_cloud_meanwhile_opened" });
    return true;
  }
  return false;
}

function handleWaitOrJumpKey(
  input: string,
  key: Key,
  ctx: OnboardingKeyContext,
  onboarding: OnboardingUiState,
): boolean {
  // The screen's claim about the pull, and with it the number of rows: a
  // failed pull adds "Retry the download". Read off the live panel slice
  // so the keyboard and the frame cannot disagree.
  const rows = waitOrJumpRowCount(
    waitOrJumpPullStatus(
      ctx.state.localModelsPanel.pull,
      ctx.state.localModelsPanel.errorLine,
    ),
  );
  if (key.upArrow || key.downArrow || input === "j" || input === "k") {
    ctx.dispatch({
      type: "onboarding_cursor_moved",
      delta: key.upArrow || input === "k" ? -1 : 1,
      length: rows,
    });
    return true;
  }
  if (key.return) {
    const row = onboarding.cursor % rows;
    if (row === 0) {
      ctx.dispatch({
        type: "onboarding_finished",
        outcome: onboarding.outcome ?? "cloud",
      });
      return true;
    }
    if (row === 1) {
      // The same wizard the cloud step runs, opened a second time; the
      // reducer sends its result back to this screen because this is the
      // step the action was dispatched from.
      ctx.dispatch({
        type: "providers_wizard_opened",
        wizard: createProvidersWizardState("add"),
      });
      ctx.dispatch({ type: "onboarding_cloud_meanwhile_opened" });
      return true;
    }
    // The retry row, shown only for a failed pull: run the same pull
    // again through the orchestrator that owns it. The resulting
    // pull_started event clears the error and flips this screen back to
    // its running state.
    if (onboarding.localModelId) {
      // Stored by `onboarding_local_model_picked` from a catalog pick,
      // so the id round-trips through state as a string.
      ctx.callbacks.onLocalModelsPullRequested?.(
        onboarding.localModelId as LocalModelId,
      );
    }
    return true;
  }
  return false;
}

function handleProposeKey(
  input: string,
  key: Key,
  ctx: OnboardingKeyContext,
  onboarding: OnboardingUiState,
): boolean {
  const skip = (): void =>
    ctx.dispatch({
      type: "onboarding_finished",
      outcome: onboarding.outcome ?? "skipped",
    });
  if (key.escape) {
    skip();
    return true;
  }
  if (key.upArrow || key.downArrow || input === "j" || input === "k") {
    ctx.dispatch({
      type: "onboarding_cursor_moved",
      delta: key.upArrow || input === "k" ? -1 : 1,
      length: 2,
    });
    return true;
  }
  if (key.return) {
    if (onboarding.cursor !== 0) {
      skip();
      return true;
    }
    if (onboarding.offer === "local") {
      persistUserLocalModelsConfig({ mode: "managed" });
      ctx.dispatch({ type: "onboarding_step_set", step: "local_pick" });
      return true;
    }
    ctx.dispatch({
      type: "providers_wizard_opened",
      wizard: createProvidersWizardState("add"),
    });
    ctx.dispatch({ type: "onboarding_step_set", step: "cloud" });
    return true;
  }
  return false;
}

// The cloud step *is* the providers wizard — same keys, same
// verification, same hot-swap — so it routes through the panel's own
// handler rather than a second implementation of it.
function handleCloudKey(input: string, key: Key, ctx: OnboardingKeyContext): boolean {
  const wizard = ctx.state.providersPanel.wizard;
  if (!wizard) return false;
  return routeProvidersWizardKey(input, key, wizard, {
    dispatch: ctx.dispatch,
    onSubmit: (w) => ctx.callbacks.onProvidersWizardSubmit?.(w),
    onSubmitCancel: () => ctx.callbacks.onProvidersWizardSubmitCancel?.(),
  });
}

