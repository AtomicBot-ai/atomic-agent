import { Box } from "ink";
import type { ReactElement } from "react";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import type { LocalModelPick } from "../onboarding/local-model-picks.js";
import type { OnboardingFit } from "../onboarding/onboarding-fit.js";
import type { OnboardingUiState } from "../onboarding/onboarding-state.js";
import type { ProvidersWizardState } from "../providers/providers-wizard-state.js";
import type { TuiAction } from "../tui-action.js";
import { OnboardingChooseStep } from "./onboarding-choose-step.js";
import { OnboardingDownloadStep } from "./onboarding-download-step.js";
import { OnboardingHeader } from "./onboarding-header.js";
import { OnboardingIntroStep } from "./onboarding-intro-step.js";
import { OnboardingLocalPickStep } from "./onboarding-local-pick-step.js";
import { OnboardingProposeStep } from "./onboarding-propose-step.js";
import { OnboardingUrlStep } from "./onboarding-url-step.js";
import { OnboardingWaitOrJumpStep } from "./onboarding-wait-or-jump-step.js";
import { ProvidersWizard } from "./providers-wizard.js";

/**
 * The header plus the step-to-screen switch, extracted whole so
 * `OnboardingScreen` stays the flow's shell — placement, effects and the
 * footer — instead of also being its longest render function. Purely
 * presentational: every decision was made by the caller, this maps the
 * current step to the component that draws it.
 */
export function OnboardingStepBody(props: {
  onboarding: OnboardingUiState;
  fit: OnboardingFit;
  /** Full terminal width; the splash sizes its art from it. */
  columns: number;
  /** Rows the surface's viewport allows the block. */
  viewportRows: number;
  subtitle: string;
  picks: readonly LocalModelPick[];
  pickCursor: number;
  ramGb: number;
  offerCloudMeanwhile: boolean;
  pull: LocalModelsPullState | null;
  wizardState: ProvidersWizardState | null;
  introSkipped: boolean;
  configuredLabel: string;
  cloudLabel: string;
  dispatch(action: TuiAction): void;
  onChatUrlSubmit(value: string): void;
  onEmbeddingUrlSubmit(value: string): void;
}): ReactElement {
  const { onboarding, dispatch } = props;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {onboarding.step === "intro" ? null : (
        <OnboardingHeader subtitle={props.subtitle} mark={props.fit.mark} />
      )}
      {/*
        The gap under the header, which the splash does not draw one
        of. Spending the row anyway cost the intro its last line.
      */}
      <Box
        flexDirection="column"
        marginTop={onboarding.step === "intro" ? 0 : 1}
        flexShrink={0}
      >
        {onboarding.step === "intro" ? (
          <OnboardingIntroStep
            columns={Math.max(20, props.columns - 4)}
            rows={props.viewportRows}
            fit={props.fit}
            skipAnimation={props.introSkipped}
          />
        ) : null}
        {onboarding.step === "choose" ? (
          <OnboardingChooseStep cursor={onboarding.cursor} fit={props.fit} />
        ) : null}
        {onboarding.step === "local_pick" ? (
          <OnboardingLocalPickStep
            picks={props.picks}
            cursor={props.pickCursor}
            ramGb={props.ramGb}
            fit={props.fit}
          />
        ) : null}
        {onboarding.step === "propose_second" && onboarding.offer ? (
          <OnboardingProposeStep
            offer={onboarding.offer}
            configuredLabel={props.configuredLabel}
            cursor={onboarding.cursor % 2}
          />
        ) : null}
        {onboarding.step === "wait_or_jump" ? (
          <OnboardingWaitOrJumpStep
            pull={props.pull}
            cloudLabel={props.cloudLabel}
            cursor={onboarding.cursor % 2}
          />
        ) : null}
        {onboarding.step === "local_download" ? (
          <OnboardingDownloadStep
            pull={props.pull}
            modelLabel={onboarding.localModelId ?? "the model"}
            offerCloudMeanwhile={props.offerCloudMeanwhile}
          />
        ) : null}
        {onboarding.step === "cloud" && props.wizardState ? (
          <ProvidersWizard wizard={props.wizardState} />
        ) : null}
        {onboarding.step === "custom_chat_url" ? (
          <OnboardingUrlStep
            kind="chat"
            value={onboarding.chatUrl}
            busy={onboarding.busy}
            error={onboarding.error}
            onChange={(value) =>
              dispatch({ type: "onboarding_url_changed", field: "chat", value })
            }
            onSubmit={props.onChatUrlSubmit}
            onBack={() => dispatch({ type: "onboarding_step_set", step: "choose" })}
          />
        ) : null}
        {onboarding.step === "custom_embedding_url" ? (
          <OnboardingUrlStep
            kind="embedding"
            value={onboarding.embeddingUrl}
            busy={onboarding.busy}
            error={onboarding.error}
            onChange={(value) =>
              dispatch({ type: "onboarding_url_changed", field: "embedding", value })
            }
            onSubmit={props.onEmbeddingUrlSubmit}
            onBack={() =>
              dispatch({ type: "onboarding_step_set", step: "custom_chat_url" })
            }
          />
        ) : null}
      </Box>
    </Box>
  );
}
