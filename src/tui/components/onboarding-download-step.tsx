import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import { widestLine } from "../onboarding/centre-onboarding-block.js";
import type { OnboardingMark } from "../onboarding/onboarding-fit.js";
import { theme } from "../theme/theme.js";
import { countOnboardingHeaderRows } from "./onboarding-header.js";
import {
  OnboardingDownloadProgress,
  PROGRESS_TEMPLATE_LINE,
} from "./onboarding-download-progress.js";

const CLOUD_OFFER = [
  "┃  Don’t want to wait? Set up a cloud model in the meantime —",
  "┃  it takes about a minute, and the download keeps running.",
] as const;
/** The failed variant: one line, because there is no download to keep. */
const CLOUD_OFFER_FAILED = "┃  Set up a cloud model instead — it takes about a minute.";
/** Set bold on the second offer line: it is the key, not the sentence. */
const CLOUD_OFFER_KEY = "    press c";

/**
 * Widest line this step draws, for the block that centres it.
 *
 * The error line is left out on purpose: it carries whatever the pull
 * failed with, and sizing the surface to an arbitrary string would
 * resize the screen around a message. It wraps inside the block instead.
 */
export function measureOnboardingDownloadStep(props: {
  modelLabel: string;
  offerCloudMeanwhile?: boolean;
}): number {
  return widestLine([
    headingLine(props.modelLabel),
    PROGRESS_TEMPLATE_LINE,
    ...(props.offerCloudMeanwhile === false
      ? []
      : [CLOUD_OFFER[0], `${CLOUD_OFFER[1]}${CLOUD_OFFER_KEY}`]),
  ]);
}

/**
 * Rows the centred download block spends while a pull is running: the
 * header and its gap (drawn by `OnboardingStepBody`), the headline, the
 * bars, the rate line, their margins, and the meanwhile offer. The
 * ambient atom field sizes itself from what the placement leaves after
 * these — see `OnboardingDownloadAmbient` — and the full-screen frame
 * test is what keeps the count honest against the JSX below. Only the
 * running shape is counted: a failed pull swaps the bars for an error
 * line, and the field has already stopped by then.
 */
export function countOnboardingDownloadBlockRows(input: {
  mark: OnboardingMark;
  offerCloud: boolean;
}): number {
  // The gap under the header (1), the headline (1), the progress top
  // margin (1), the two bars (2), the rate line and its margin (2), and
  // the offer's top margin plus two lines when it shows.
  return countOnboardingHeaderRows(input.mark) + 7 + (input.offerCloud ? 4 : 0);
}

function headingLine(modelLabel: string): string {
  return `Downloading ${modelLabel}. You can leave this running.`;
}

/**
 * The download, as its own screen.
 *
 * The bars, the rate and the ETA are shared with the "almost there"
 * screen — see {@link OnboardingDownloadProgress}. What this screen adds
 * is the offer to spend the wait setting up a cloud model instead. The
 * atom field that used to live here is the surface's ambience now
 * (`OnboardingDownloadAmbient`): it spans the full terminal below this
 * block, which a block centred to its own text cannot contain.
 */
export function OnboardingDownloadStep(props: {
  pull: LocalModelsPullState | null;
  /**
   * The panel's `errorLine`. This — not `pull.error` — is how a failed
   * pull actually arrives: `local_models_pull_failed` nulls the pull
   * and leaves the message here, and the next `pull_started` clears it.
   */
  pullError: string | null;
  modelLabel: string;
  /** Hidden once a cloud provider is configured — nothing left to offer. */
  offerCloudMeanwhile?: boolean;
}): ReactElement {
  const pull = props.pull;
  // A failed pull nulls itself and reports through `errorLine`; the
  // headline and the offer must not keep claiming a running download.
  const failed = pull === null && props.pullError !== null;
  const offerCloud = props.offerCloudMeanwhile !== false;

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={theme.colors.muted} wrap="truncate">
        {failed
          ? `The ${props.modelLabel} download failed.`
          : headingLine(props.modelLabel)}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <OnboardingDownloadProgress pull={pull} error={props.pullError} />
      </Box>
      {offerCloud ? (
        <Box flexDirection="column" marginTop={2}>
          {/*
            Accent-marked because it is an offer, not a status line: the
            wait is measured in minutes and a cloud model takes about
            one. The download is owned by the orchestrator, so setting
            one up does not pause or restart it.
          */}
          {failed ? (
            <Text color={theme.colors.accent} wrap="truncate">
              {CLOUD_OFFER_FAILED}
              <Text bold>{CLOUD_OFFER_KEY}</Text>
            </Text>
          ) : (
            <>
              <Text color={theme.colors.accent}>{CLOUD_OFFER[0]}</Text>
              <Text color={theme.colors.accent}>
                {CLOUD_OFFER[1]}
                <Text bold>{CLOUD_OFFER_KEY}</Text>
              </Text>
            </>
          )}
        </Box>
      ) : null}
    </Box>
  );
}
