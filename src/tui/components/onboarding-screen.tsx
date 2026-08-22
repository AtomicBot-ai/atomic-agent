import { Box, Text } from "ink";
import { useCallback, useEffect, useMemo, useRef, type ReactElement } from "react";
import { getConfig } from "../../config/index.js";
import {
  isCloudTextProviderReady,
  isLocalBackendConfigured,
} from "../local-backend-readiness.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { ROOT_PADDING_LEFT } from "../layout.js";
import { useOnboardingInputs } from "../hooks/use-onboarding-inputs.js";
import { useOnboardingUrlActions } from "../hooks/use-onboarding-url-actions.js";
import {
  buildLocalModelPicks,
  buildLocalPickRows,
  describeDownloadingModel,
  hostRamGb,
  orderLocalModelPicks,
} from "../onboarding/local-model-picks.js";
import {
  ONBOARDING_SUBTITLES,
  onboardingFooterFor,
} from "../onboarding/onboarding-chrome.js";
import {
  computeOnboardingFit,
  ONBOARDING_SIZE_ADVICE,
} from "../onboarding/onboarding-fit.js";
import { handleOnboardingStepKey } from "../onboarding/onboarding-step-keys.js";
import { useIntroInput } from "../onboarding/use-intro-input.js";
import { arrowKey } from "../mouse/synthetic-key.js";
import {
  decideSecondBackendOffer,
  isLocalSetupStep,
} from "../onboarding/propose-second-backend.js";
import type {
  OnboardingOutcome,
  OnboardingUiState,
} from "../onboarding/onboarding-state.js";
import { persistOnboardingState } from "../persist-onboarding-state.js";
import { theme } from "../theme/theme.js";
import type { TuiAction } from "../tui-action.js";
import type { LocalModelId } from "../../local-llm/index.js";
import type { TuiState } from "../tui-state.js";
import { OnboardingStepBody } from "./onboarding-step-body.js";
import {
  layOutOnboardingSurface,
  SURFACE_PADDING_TOP,
} from "./onboarding-surface-layout.js";

export interface OnboardingScreenCallbacks {
  /** Verify + save + hot-swap the cloud provider (the panel's own path). */
  onProvidersWizardSubmit?(
    wizard: import("../providers/providers-wizard-state.js").ProvidersWizardState,
  ): void;
  onProvidersWizardSubmitCancel?(): void;
  /** Reload the runtime's providers once the flow has written config. */
  onOnboardingFinished?(outcome: OnboardingOutcome): void;
  /** Start a model pull. Owned by `LocalModelsOrchestrator`. */
  onLocalModelsPullRequested?(modelId: LocalModelId): void;
}

/** Named once — the offer screens quote it back at the operator. */
const CLOUD_READY_LABEL = "Cloud model ready";


/**
 * The whole first-run surface. It owns the terminal while it is mounted:
 * no status bar, no rail, no composer, no hint strip but its own, and
 * that strip is pinned to the real last row rather than trailing the
 * content.
 *
 * The screen itself is the flow's shell — placement, effects and the
 * footer. The keys live in `useOnboardingInputs`, the endpoint writes in
 * `useOnboardingUrlActions`, and the step switch in `OnboardingStepBody`;
 * the reducer stays pure so the step machine can be tested as a table.
 */
export function OnboardingScreen(props: {
  state: TuiState;
  onboarding: OnboardingUiState;
  dispatch(action: TuiAction): void;
  callbacks: OnboardingScreenCallbacks;
  /**
   * Whether the app-level Ctrl+C quit chord is armed. The flow draws its
   * own footer instead of the chat hint strip, so it must make the same
   * "press again to quit" promise the strip makes — without it the first
   * press looks like it did nothing and the second lands after the
   * 1.5s window has disarmed it, which reads as "Ctrl+C is broken".
   */
  ctrlCArmed?: boolean;
}): ReactElement {
  const { onboarding, dispatch, callbacks } = props;
  const size = useTerminalSize();
  const fit = computeOnboardingFit(size);
  const ramGb = useMemo(() => hostRamGb(), []);
  // Read once per step change rather than per render: it only moves when
  // the flow itself writes config.
  const cloudAlreadyConfigured = useMemo(
    () => isCloudTextProviderReady(),
    [onboarding.step],
  );
  const settling = useRef(false);

  const dismissIntro = useCallback(() => {
    // Recorded as it is dismissed, not at the end of the flow: an
    // operator who quits at the backend choice has still seen the
    // splash, and a later release may want to know that.
    persistOnboardingState({ introSeenAt: new Date().toISOString() });
    dispatch({ type: "onboarding_step_set", step: "choose" });
  }, [dispatch]);
  // The splash answers to keys, clicks, the wheel and pastes alike, so
  // all four live in one hook rather than in the flow's key hook. The
  // same hook keeps the whole-surface mouse target registered on every
  // step; a wheel notch outside the splash walks the current list
  // through the same key table the arrows use.
  const intro = useIntroInput({
    onboarding,
    onDismiss: dismissIntro,
    onSurfaceWheel: (direction) =>
      handleOnboardingStepKey("", arrowKey(direction), {
        state: props.state,
        dispatch,
        callbacks,
      }),
  });

  const finish = useCallback(
    (outcome: OnboardingOutcome) => {
      dispatch({ type: "onboarding_finished", outcome });
    },
    [dispatch],
  );

  const picks = useMemo(
    () => orderLocalModelPicks(buildLocalModelPicks(ramGb)),
    [ramGb],
  );
  const pickRows = useMemo(() => buildLocalPickRows(picks), [picks]);
  const pickCursor = onboarding.cursor % Math.max(1, pickRows.length);
  const wizardState = props.state.providersPanel.wizard;

  useOnboardingInputs({ state: props.state, dispatch, callbacks });
  const { probeAndAdvance, saveEmbeddingUrl } = useOnboardingUrlActions({
    onboarding,
    dispatch,
    finish,
  });

  // Stamped on arrival rather than on success, and before anything is
  // downloaded: an operator who opened the model list and pressed esc
  // has already read everything the later "set up local models too"
  // screen would tell them.
  useEffect(() => {
    if (!isLocalSetupStep(onboarding.step)) return;
    if (getConfig().tui.onboarding.localSetupSeenAt !== null) return;
    persistOnboardingState({ localSetupSeenAt: new Date().toISOString() });
  }, [onboarding.step]);

  // Closing down runs once. The stamp is what stops the flow reopening
  // on the next launch, so it is written before the surface unmounts.
  useEffect(() => {
    if (onboarding.step !== "finished" || settling.current) return;
    const outcome = onboarding.outcome ?? "skipped";
    const config = getConfig();
    const offer = decideSecondBackendOffer({
      outcome,
      cloudReady: isCloudTextProviderReady(),
      localReady: isLocalBackendConfigured(),
      alreadyProposed: config.tui.onboarding.proposedSecondBackendAt !== null,
      localSetupSeen: config.tui.onboarding.localSetupSeenAt !== null,
    });
    if (offer) {
      // Recorded when it is shown, not when it is answered: the offer
      // was made either way, and a declined offer must not come back.
      persistOnboardingState({ proposedSecondBackendAt: new Date().toISOString() });
      dispatch({ type: "onboarding_second_backend_offered", offer });
      return;
    }
    settling.current = true;
    const now = new Date().toISOString();
    persistOnboardingState(outcome === "skipped" ? { skippedAt: now } : { completedAt: now });
    callbacks.onOnboardingFinished?.(outcome);
    dispatch({ type: "onboarding_set", onboarding: null });
  }, [callbacks, dispatch, onboarding.outcome, onboarding.step]);

  // Both axes are centred on the block as a whole, never line by line:
  // a column of options whose rows each find their own centre is ragged
  // to scan, and every row would move whenever its text changed.
  // The Hugging Face file list runs its own cursor over the repo's
  // choices; every other list shares the pick rows' modulus.
  const blockCursor =
    onboarding.step === "local_hf_pick" && onboarding.hfRepo
      ? onboarding.cursor % Math.max(1, onboarding.hfRepo.choices.length)
      : pickCursor;
  const placement = layOutOnboardingSurface({
    columns: size.columns,
    rows: size.rows,
    step: onboarding.step,
    fit,
    subtitle: ONBOARDING_SUBTITLES[onboarding.step],
    picks,
    cursor: blockCursor,
    ramGb,
    offer: onboarding.offer,
    configuredLabel: configuredLabel(onboarding.outcome),
    modelLabel: describeDownloadingModel(onboarding.localModelId),
    offerCloudMeanwhile: !cloudAlreadyConfigured,
    pull: props.state.localModelsPanel.pull,
    pullError: props.state.localModelsPanel.errorLine,
    cloudLabel: CLOUD_READY_LABEL,
    hfRepo: onboarding.hfRepo,
    hfError: onboarding.step === "local_hf_ref" ? onboarding.error : null,
  });

  return (
    // The root gutter is padding on THIS box, not on the app frame the
    // screen mounts into: padding sits inside the border box, so the
    // splash's mouse target measures the full terminal width and a
    // click in the two inset columns counts like any other.
    <Box
      flexDirection="column"
      flexGrow={1}
      paddingTop={SURFACE_PADDING_TOP}
      paddingLeft={ROOT_PADDING_LEFT}
      ref={intro.ref}
    >
      {/*
        Two spacers rather than `justifyContent="center"`: flex hands out
        free space only when there is some, so a step taller than the
        budget collapses them and starts at the top instead of hanging
        equally off both ends. `overflow` then keeps its tail away from
        the hint strip — Ink 7 paints over earlier rows rather than
        clipping a frame that does not fit.
      */}
      <Box
        flexDirection="column"
        flexShrink={0}
        height={placement.rows}
        overflow="hidden"
      >
        <Box flexGrow={1} flexShrink={1} />
        <Box
          flexDirection="column"
          flexShrink={0}
          marginLeft={placement.left}
          width={placement.width}
        >
          <OnboardingStepBody
            onboarding={onboarding}
            fit={fit}
            columns={size.columns}
            viewportRows={placement.rows}
            subtitle={ONBOARDING_SUBTITLES[onboarding.step]}
            picks={picks}
            pickCursor={pickCursor}
            ramGb={ramGb}
            offerCloudMeanwhile={!cloudAlreadyConfigured}
            pull={props.state.localModelsPanel.pull}
            pullError={props.state.localModelsPanel.errorLine}
            wizardState={wizardState}
            introSkipped={intro.skipAnimation}
            configuredLabel={configuredLabel(onboarding.outcome)}
            cloudLabel={CLOUD_READY_LABEL}
            terminalRows={size.rows}
            blockWidth={placement.width}
            dispatch={dispatch}
            onChatUrlSubmit={(value) => void probeAndAdvance(value)}
            onEmbeddingUrlSubmit={(value) => void saveEmbeddingUrl(value)}
          />
        </Box>
        <Box flexGrow={1} flexShrink={1} />
      </Box>
      {/*
        The budgeted viewport above is what pins the hints to the true
        bottom: the root Box is sized to the terminal, the viewport takes
        every row but this one, and the strip lands on the last row
        instead of trailing the content.
      */}
      <Box flexShrink={0}>
        <Text color={theme.colors.muted} wrap="truncate">
          {onboardingFooterFor(onboarding, props.ctrlCArmed ?? false, wizardState)}
          {fit.sizeAdvice ? `   ·   ${ONBOARDING_SIZE_ADVICE}` : ""}
        </Text>
      </Box>
    </Box>
  );
}

/** What the flow just finished setting up, named on the offer screen. */
function configuredLabel(outcome: OnboardingOutcome | null): string {
  if (outcome === "local") return "Local model ready";
  if (outcome === "cloud") return CLOUD_READY_LABEL;
  return "Backend ready";
}
