import { Box, Text } from "ink";
import { useCallback, useEffect, useMemo, useRef, type ReactElement } from "react";
import { getConfig } from "../../config/index.js";
import {
  isCloudTextProviderReady,
  isLocalBackendConfigured,
} from "../local-backend-readiness.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { useOnboardingInputs } from "../hooks/use-onboarding-inputs.js";
import { useOnboardingUrlActions } from "../hooks/use-onboarding-url-actions.js";
import {
  buildLocalModelPicks,
  hostRamGb,
  orderLocalModelPicks,
} from "../onboarding/local-model-picks.js";
import {
  computeOnboardingFit,
  ONBOARDING_SIZE_ADVICE,
} from "../onboarding/onboarding-fit.js";
import { decideSecondBackendOffer } from "../onboarding/propose-second-backend.js";
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

const SUBTITLES: Record<OnboardingUiState["step"], string> = {
  intro: "",
  choose: "setup · step 1 of 2",
  local_pick: "local models · step 2 of 2",
  local_download: "local models · downloading",
  propose_second: "one more thing",
  wait_or_jump: "almost there",
  cloud: "cloud model · step 2 of 2",
  custom_chat_url: "custom endpoint · step 2 of 2",
  custom_embedding_url: "custom endpoint · embeddings",
  finished: "setting up…",
};

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
  const pickCursor = onboarding.cursor % Math.max(1, picks.length);
  const wizardState = props.state.providersPanel.wizard;

  const { introSkipped } = useOnboardingInputs({
    onboarding,
    dispatch,
    callbacks,
    picks,
    wizardState,
    finish,
  });
  const { probeAndAdvance, saveEmbeddingUrl } = useOnboardingUrlActions({
    onboarding,
    dispatch,
    finish,
  });

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
  const placement = layOutOnboardingSurface({
    columns: size.columns,
    rows: size.rows,
    step: onboarding.step,
    fit,
    subtitle: SUBTITLES[onboarding.step],
    picks,
    cursor: pickCursor,
    ramGb,
    offer: onboarding.offer,
    configuredLabel: configuredLabel(onboarding.outcome),
    modelLabel: onboarding.localModelId ?? "the model",
    offerCloudMeanwhile: !cloudAlreadyConfigured,
    pull: props.state.localModelsPanel.pull,
    cloudLabel: CLOUD_READY_LABEL,
  });

  return (
    <Box flexDirection="column" flexGrow={1} paddingTop={SURFACE_PADDING_TOP}>
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
            subtitle={SUBTITLES[onboarding.step]}
            picks={picks}
            pickCursor={pickCursor}
            ramGb={ramGb}
            offerCloudMeanwhile={!cloudAlreadyConfigured}
            pull={props.state.localModelsPanel.pull}
            wizardState={wizardState}
            introSkipped={introSkipped}
            configuredLabel={configuredLabel(onboarding.outcome)}
            cloudLabel={CLOUD_READY_LABEL}
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
          {footerFor(onboarding)}
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

function footerFor(onboarding: OnboardingUiState): string {
  switch (onboarding.step) {
    case "choose":
      return "↑/↓ move   enter select   1–3 jump   esc skip   ctrl+c quit";
    case "cloud":
      return "↑/↓ move   enter select   esc back   ctrl+c quit";
    case "custom_chat_url":
      return "enter test & continue   esc back   ctrl+c quit";
    case "custom_embedding_url":
      return "enter test & save   empty enter skips embeddings   esc back   ctrl+c quit";
    case "local_pick":
      return "↑/↓ move   enter download   esc back   ctrl+c quit";
    case "local_download":
      return "c set up cloud meanwhile   ctrl+c quit";
    case "propose_second":
      return "↑/↓ move   enter select   esc skip   ctrl+c quit";
    case "wait_or_jump":
      return "↑/↓ move   enter select   ctrl+c quit";
    case "finished":
      return "";
    case "intro":
      return "ctrl+c quit";
  }
}
