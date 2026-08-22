import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import { theme } from "../theme/theme.js";
import { OnboardingDownloadProgress } from "./onboarding-download-progress.js";

/**
 * The download, as its own screen.
 *
 * The bars, the rate and the ETA are shared with the "almost there"
 * screen — see {@link OnboardingDownloadProgress}. What this screen adds
 * is the offer to spend the wait setting up a cloud model instead.
 */
export function OnboardingDownloadStep(props: {
  pull: LocalModelsPullState | null;
  /** The pull's failure, from the panel's `errorLine`. */
  error: string | null;
  modelLabel: string;
  /** Hidden once a cloud provider is configured — nothing left to offer. */
  offerCloudMeanwhile?: boolean;
}): ReactElement {
  // A failed pull nulls itself and reports through `errorLine`; the
  // headline and the offer must not keep claiming a running download.
  const failed = props.pull === null && props.error !== null;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={theme.colors.muted} wrap="truncate">
        {failed
          ? `The ${props.modelLabel} download failed.`
          : `Downloading ${props.modelLabel}. You can leave this running.`}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <OnboardingDownloadProgress pull={props.pull} error={props.error} />
      </Box>
      {props.offerCloudMeanwhile === false ? null : (
        <Box flexDirection="column" marginTop={2}>
          {/*
            Accent-marked because it is an offer, not a status line: the
            wait is measured in minutes and a cloud model takes about
            one. The download is owned by the orchestrator, so setting
            one up does not pause or restart it.
          */}
          {failed ? (
            <Text color={theme.colors.accent} wrap="truncate">
              ┃  Set up a cloud model instead — it takes about a minute.
              <Text bold>{"    press c"}</Text>
            </Text>
          ) : (
            <>
              <Text color={theme.colors.accent}>
                ┃  Don{"\u2019"}t want to wait? Set up a cloud model in the meantime —
              </Text>
              <Text color={theme.colors.accent}>
                ┃  it takes about a minute, and the download keeps running.
                <Text bold>{"    press c"}</Text>
              </Text>
            </>
          )}
        </Box>
      )}
    </Box>
  );
}
