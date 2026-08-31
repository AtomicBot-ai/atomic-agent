import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MouseListRow, pressEnter } from "../mouse/mouse-list-row.js";
import { widestLine } from "../onboarding/centre-onboarding-block.js";
import { handleOnboardingStepKey } from "../onboarding/onboarding-step-keys.js";
import { ROW_INDENT, rowPrefix } from "../onboarding/onboarding-rows.js";
import type { SecondBackendOffer } from "../onboarding/propose-second-backend.js";
import { theme } from "../theme/theme.js";

/** Hand-wrapped, so the measured block width matches what is drawn. */
const EXPLAINER: readonly string[] = [
  "atomic-agent runs both side by side — local for private or offline work,",
  "cloud for the heavy turns, switchable mid-session. You have one of the two.",
];

const SKIP_ROW = {
  label: "Skip — take me to the agent",
  detail: "you can add it later from the menu (esc)",
} as const;

function acceptRow(offer: NonNullable<SecondBackendOffer>): {
  label: string;
  detail: string;
} {
  return offer === "local"
    ? {
        label: "Set up local models too",
        detail: "one download, then it runs offline and costs nothing per token",
      }
    : {
        label: "Set up a cloud model too",
        detail: "an API key and a model — about a minute, for the heavy turns",
      };
}

/** Widest line this step draws, for the block that centres it. */
export function measureOnboardingProposeStep(props: {
  offer: NonNullable<SecondBackendOffer>;
  configuredLabel: string;
}): number {
  const rows = [acceptRow(props.offer), SKIP_ROW];
  return widestLine([
    `${theme.glyphs.check}  ${props.configuredLabel}`,
    ...EXPLAINER,
    ...rows.flatMap((row) => [
      `${ROW_INDENT}${row.label}`,
      `${ROW_INDENT}${row.detail}`,
    ]),
  ]);
}

/**
 * "You have one — want the other too?", shown once, after the first
 * backend actually works.
 *
 * The pitch is the product's actual shape: local and cloud are not
 * alternatives here, they run side by side and switch mid-session. An
 * operator who set up one usually does not know that.
 */
export function OnboardingProposeStep(props: {
  offer: NonNullable<SecondBackendOffer>;
  configuredLabel: string;
  cursor: number;
}): ReactElement {
  const accept = acceptRow(props.offer);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text>
        <Text color={theme.colors.success}>{`${theme.glyphs.check}  `}</Text>
        <Text>{props.configuredLabel}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {EXPLAINER.map((line) => (
          <Text key={line} color={theme.colors.muted}>
            {line}
          </Text>
        ))}
      </Box>
      <Row selected={props.cursor === 0} index={0} label={accept.label} detail={accept.detail} />
      <Row
        selected={props.cursor === 1}
        index={1}
        label={SKIP_ROW.label}
        detail={SKIP_ROW.detail}
      />
    </Box>
  );
}

function Row(props: {
  selected: boolean;
  /** This row's place in the two-row cursor space, for click-to-select. */
  index: number;
  label: string;
  detail: string;
}): ReactElement {
  return (
    // First click selects, second activates — the same Enter the
    // keyboard sends, through the flow's own key table.
    <MouseListRow
      selected={props.selected}
      onSelect={(mouse) =>
        mouse.dispatch({ type: "onboarding_cursor_set", cursor: props.index })
      }
      onActivate={pressEnter(handleOnboardingStepKey)}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text color={props.selected ? theme.colors.accent : undefined} bold={props.selected}>
          {`${rowPrefix(props.selected)}${props.label}`}
        </Text>
        <Text color={theme.colors.muted}>{`${ROW_INDENT}${props.detail}`}</Text>
      </Box>
    </MouseListRow>
  );
}
