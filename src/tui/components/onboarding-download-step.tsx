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
  modelLabel: string;
  /** Hidden once a cloud provider is configured — nothing left to offer. */
  offerCloudMeanwhile?: boolean;
}): ReactElement {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={theme.colors.muted}>
        {`Downloading ${props.modelLabel}. You can leave this running.`}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <OnboardingDownloadProgress pull={props.pull} />
      </Box>
      {props.offerCloudMeanwhile === false ? null : (
        <Box flexDirection="column" marginTop={2}>
          {/*
            Accent-marked because it is an offer, not a status line: the
            wait is measured in minutes and a cloud model takes about
            one. The download is owned by the orchestrator, so setting
            one up does not pause or restart it.
          */}
          <Text color={theme.colors.accent}>
            ┃  Don{"\u2019"}t want to wait? Set up a cloud model in the meantime —
          </Text>
          <Text color={theme.colors.accent}>
            ┃  it takes about a minute, and the download keeps running.
            <Text bold>{"    press c"}</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
