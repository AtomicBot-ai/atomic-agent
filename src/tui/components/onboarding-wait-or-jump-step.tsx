import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import type { OnboardingFit } from "../onboarding/onboarding-fit.js";
import { theme } from "../theme/theme.js";
import { OnboardingDownloadProgress } from "./onboarding-download-progress.js";

/**
 * Reached only from the "set up cloud while this downloads" path: the
 * cloud model is ready and the local one is still coming down.
 *
 * The screen says the download is still running, so it shows the same
 * bars the download step shows rather than a one-line summary of them.
 *
 * Waiting is not a row. The pull is owned by the orchestrator and the
 * top bar reports it, so sitting on this screen buys nothing the agent
 * does not already give; the two things worth doing here are leaving,
 * and adding one more cloud provider before leaving.
 *
 * The bars cost five rows the old summary line did not, so the prose
 * around them is what gets shed on a short terminal — Ink overlaps the
 * rows above rather than clipping, and the rows themselves have to
 * survive that.
 */
export function OnboardingWaitOrJumpStep(props: {
  pull: LocalModelsPullState | null;
  cloudLabel: string;
  modelLabel: string;
  cursor: number;
  fit: OnboardingFit;
}): ReactElement {
  const jumpDetail = "the download keeps running; progress shows in the top bar";
  const addDetail = "one more key or endpoint, then straight back to this screen";
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text>
        <Text color={theme.colors.success}>{`${theme.glyphs.check}  `}</Text>
        <Text>{props.cloudLabel}</Text>
      </Text>
      {props.fit.explainer ? (
        <Text color={theme.colors.muted}>
          {`Still downloading ${props.modelLabel} — it keeps running whichever row you pick.`}
        </Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <OnboardingDownloadProgress pull={props.pull} />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Row
          selected={props.cursor === 0}
          label="Start using the agent now"
          detail={props.fit.rowDetails ? jumpDetail : null}
        />
        <Row
          selected={props.cursor === 1}
          label="Add another cloud provider"
          detail={props.fit.rowDetails ? addDetail : null}
        />
      </Box>
    </Box>
  );
}

function Row(props: {
  selected: boolean;
  label: string;
  detail: string | null;
}): ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={props.selected ? theme.colors.accent : undefined} bold={props.selected}>
        {`${props.selected ? "›  " : "   "}${props.label}`}
      </Text>
      {props.detail ? (
        <Text color={theme.colors.muted}>{`   ${props.detail}`}</Text>
      ) : null}
    </Box>
  );
}
