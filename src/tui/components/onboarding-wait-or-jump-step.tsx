import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { formatEta, formatBytes, useTransferRate } from "../hooks/use-transfer-rate.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import { theme } from "../theme/theme.js";

/**
 * Reached only from the "set up cloud while this downloads" path: the
 * cloud model is ready and the local one is still coming down, which is
 * a question rather than a conclusion.
 *
 * Jumping is the default row. The download does not need this screen to
 * survive — the orchestrator owns it — so waiting is a preference, not a
 * requirement, and the top bar reports progress either way.
 */
export function OnboardingWaitOrJumpStep(props: {
  pull: LocalModelsPullState | null;
  cloudLabel: string;
  cursor: number;
}): ReactElement {
  const { etaSeconds } = useTransferRate(
    props.pull?.transferredBytes ?? 0,
    props.pull?.totalBytes ?? 0,
  );
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text>
        <Text color={theme.colors.success}>{`${theme.glyphs.check}  `}</Text>
        <Text>{props.cloudLabel}</Text>
      </Text>
      {props.pull ? (
        <Text>
          <Text color={theme.colors.accent}>{"⇣  "}</Text>
          <Text color={theme.colors.muted}>
            {`${String(props.pull.modelId)} · ${Math.round(props.pull.percent)}% · `}
            {`${formatBytes(props.pull.transferredBytes)} / ${formatBytes(props.pull.totalBytes)} · `}
            {formatEta(etaSeconds)}
          </Text>
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        <Row
          selected={props.cursor === 0}
          label="Start using the agent now"
          detail="the download keeps running; progress shows in the top bar"
        />
        <Row
          selected={props.cursor === 1}
          label="Wait here until it finishes"
          detail="the agent opens with both backends live"
        />
      </Box>
    </Box>
  );
}

function Row(props: { selected: boolean; label: string; detail: string }): ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={props.selected ? theme.colors.accent : undefined} bold={props.selected}>
        {`${props.selected ? "›  " : "   "}${props.label}`}
      </Text>
      <Text color={theme.colors.muted}>{`   ${props.detail}`}</Text>
    </Box>
  );
}
