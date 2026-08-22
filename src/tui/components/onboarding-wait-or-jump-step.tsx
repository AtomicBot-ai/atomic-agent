import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { formatEta, formatBytes, useTransferRate } from "../hooks/use-transfer-rate.js";
import { widestLine } from "../onboarding/centre-onboarding-block.js";
import { ROW_INDENT, rowPrefix } from "../onboarding/onboarding-rows.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import { theme } from "../theme/theme.js";

const ROWS = [
  {
    label: "Start using the agent now",
    detail: "the download keeps running; progress shows in the top bar",
  },
  {
    label: "Wait here until it finishes",
    detail: "the agent opens with both backends live",
  },
] as const;

/** Marker on the progress line, the same width as a row's marker. */
const PROGRESS_MARKER = "⇣  ";

/**
 * The widest the progress tail ever gets: full percentage, two
 * three-digit byte counts and the longest phrase `formatEta` returns.
 *
 * Measured from this template rather than from the live counters, so
 * the block does not slide sideways every time a byte count gains a
 * digit. The cost is a little slack on the right while the numbers are
 * still short, which nobody can see; the alternative is a screen that
 * twitches for the length of a multi-gigabyte download.
 */
const PROGRESS_TAIL = " · 100% · 999.9 GB / 999.9 GB · less than a minute left";

/** Widest line this step draws, for the block that centres it. */
export function measureOnboardingWaitOrJumpStep(props: {
  pull: LocalModelsPullState | null;
  cloudLabel: string;
}): number {
  return widestLine([
    `${theme.glyphs.check}  ${props.cloudLabel}`,
    ...(props.pull
      ? [`${PROGRESS_MARKER}${String(props.pull.modelId)}${PROGRESS_TAIL}`]
      : []),
    ...ROWS.flatMap((row) => [
      `${ROW_INDENT}${row.label}`,
      `${ROW_INDENT}${row.detail}`,
    ]),
  ]);
}

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
          <Text color={theme.colors.accent}>{PROGRESS_MARKER}</Text>
          <Text color={theme.colors.muted}>
            {`${String(props.pull.modelId)} · ${Math.round(props.pull.percent)}% · `}
            {`${formatBytes(props.pull.transferredBytes)} / ${formatBytes(props.pull.totalBytes)} · `}
            {formatEta(etaSeconds)}
          </Text>
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {ROWS.map((row, index) => (
          <Row
            key={row.label}
            selected={props.cursor === index}
            label={row.label}
            detail={row.detail}
          />
        ))}
      </Box>
    </Box>
  );
}

function Row(props: { selected: boolean; label: string; detail: string }): ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={props.selected ? theme.colors.accent : undefined} bold={props.selected}>
        {`${rowPrefix(props.selected)}${props.label}`}
      </Text>
      <Text color={theme.colors.muted}>{`${ROW_INDENT}${props.detail}`}</Text>
    </Box>
  );
}
