/**
 * Where the first-run surface puts its content, step by step.
 *
 * `OnboardingScreen` centres a left-aligned block, and a block can only
 * be centred against a width somebody measured. Each step answers for
 * its own widest line next to the strings it draws, so the two cannot
 * drift; this module is the switch between them — plus the header that
 * sits above every one of them — and hands the result to the placement
 * arithmetic.
 */

import { ROOT_PADDING_LEFT } from "../layout.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import {
  placeOnboardingBlock,
  type OnboardingBlockPlacement,
} from "../onboarding/centre-onboarding-block.js";
import type { LocalModelPick } from "../onboarding/local-model-picks.js";
import type { OnboardingFit } from "../onboarding/onboarding-fit.js";
import type {
  OnboardingHuggingFaceRepo,
  OnboardingStep,
} from "../onboarding/onboarding-state.js";
import type { SecondBackendOffer } from "../onboarding/propose-second-backend.js";
import { measureOnboardingChooseStep } from "./onboarding-choose-step.js";
import { measureOnboardingDownloadStep } from "./onboarding-download-step.js";
import { measureOnboardingHeader } from "./onboarding-header.js";
import { measureOnboardingHfPickStep } from "./onboarding-hf-pick-step.js";
import { measureOnboardingHfRefStep } from "./onboarding-hf-ref-step.js";
import { measureOnboardingLocalPickStep } from "./onboarding-local-pick-step.js";
import { measureOnboardingProposeStep } from "./onboarding-propose-step.js";
import { measureProvidersWizard } from "./providers-wizard-measure.js";
import { measureOnboardingUrlStep } from "./onboarding-url-step.js";
import { measureOnboardingWaitOrJumpStep } from "./onboarding-wait-or-jump-step.js";

/** Rows the surface spends above the block; matches its own `paddingTop`. */
export const SURFACE_PADDING_TOP = 1;
/** The hint strip: one row, pinned to the last line of the terminal. */
export const FOOTER_ROWS = 1;

export interface OnboardingBlockInput {
  step: OnboardingStep;
  fit: OnboardingFit;
  /** Line under the wordmark, e.g. `setup · step 1 of 2`. */
  subtitle: string;
  picks: readonly LocalModelPick[];
  cursor: number;
  ramGb: number;
  offer: SecondBackendOffer;
  /** What the flow just finished setting up, named on the offer screen. */
  configuredLabel: string;
  modelLabel: string;
  offerCloudMeanwhile: boolean;
  pull: LocalModelsPullState | null;
  cloudLabel: string;
  /** The pull's failure, from the panel's `errorLine`. */
  pullError?: string | null;
  /** The resolved Hugging Face repo, while the flow is on its file list. */
  hfRepo: OnboardingHuggingFaceRepo | null;
  /** The reference screen's error, which widens its block when long. */
  hfError?: string | null;
}

export function layOutOnboardingSurface(
  input: OnboardingBlockInput & { columns: number; rows: number },
): OnboardingBlockPlacement {
  return placeOnboardingBlock({
    columns: input.columns,
    rows: input.rows,
    blockWidth: measureOnboardingBlock({
      ...input,
      available: Math.max(0, input.columns - ROOT_PADDING_LEFT),
    }),
    paddingLeft: ROOT_PADDING_LEFT,
    paddingTop: SURFACE_PADDING_TOP,
    footerRows: FOOTER_ROWS,
  });
}

/** The same input, plus the columns the root inset leaves behind. */
interface MeasureInput extends OnboardingBlockInput {
  available: number;
}

export function measureOnboardingBlock(input: MeasureInput): number {
  // The splash pads its own art to the full measure it is handed, so it
  // is already centred and the container must not move it again.
  if (input.step === "intro") return input.available;
  return Math.max(
    measureOnboardingHeader(input.subtitle, input.fit.mark),
    measureStepBody(input),
  );
}

function measureStepBody(input: MeasureInput): number {
  switch (input.step) {
    case "choose":
      return measureOnboardingChooseStep(input.fit);
    case "local_pick":
      return measureOnboardingLocalPickStep({
        picks: input.picks,
        cursor: input.cursor,
        ramGb: input.ramGb,
        fit: input.fit,
      });
    case "local_download":
      // The text block centres like any other step. The atom field is
      // the surface's ambience now — drawn outside this block, at full
      // terminal width, by `OnboardingDownloadAmbient` — so the measure
      // is the text's own rather than the whole terminal.
      return measureOnboardingDownloadStep({
        modelLabel: input.modelLabel,
        offerCloudMeanwhile: input.offerCloudMeanwhile,
      });
    case "cloud":
      // The wizard's deterministic lines, measured beside the strings it
      // draws; its live catalog rows truncate inside the box by design.
      return Math.min(input.available, measureProvidersWizard());
    case "custom_chat_url":
      return measureOnboardingUrlStep("chat");
    case "custom_embedding_url":
      return measureOnboardingUrlStep("embedding");
    case "local_hf_ref":
      return Math.min(input.available, measureOnboardingHfRefStep(input.hfError ?? null));
    case "local_hf_pick":
      return Math.min(
        input.available,
        measureOnboardingHfPickStep(input.hfRepo, input.cursor),
      );
    case "propose_second":
      return input.offer
        ? measureOnboardingProposeStep({
            offer: input.offer,
            configuredLabel: input.configuredLabel,
          })
        : 0;
    case "wait_or_jump":
      return measureOnboardingWaitOrJumpStep({
        pull: input.pull,
        pullError: input.pullError ?? null,
        cloudLabel: input.cloudLabel,
        modelLabel: input.modelLabel,
        fit: input.fit,
      });
    // The flow is closing down and draws nothing but its own footer.
    case "finished":
    case "intro":
      return 0;
  }
}
