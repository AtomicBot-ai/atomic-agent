import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { SecondBackendOffer } from "../onboarding/propose-second-backend.js";
import { theme } from "../theme/theme.js";

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
  const rows =
    props.offer === "local"
      ? {
          accept: "Set up local models too",
          acceptDetail: "one download, then it runs offline and costs nothing per token",
        }
      : {
          accept: "Set up a cloud model too",
          acceptDetail: "an API key and a model — about a minute, for the heavy turns",
        };
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text>
        <Text color={theme.colors.success}>{`${theme.glyphs.check}  `}</Text>
        <Text>{props.configuredLabel}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Text color={theme.colors.muted}>
          atomic-agent runs both side by side — local for private or offline work,
        </Text>
        <Text color={theme.colors.muted}>
          cloud for the heavy turns, switchable mid-session. You have one of the two.
        </Text>
      </Box>
      <Row selected={props.cursor === 0} label={rows.accept} detail={rows.acceptDetail} />
      <Row
        selected={props.cursor === 1}
        label="Skip — take me to the agent"
        detail="you can add it later from the menu (ctrl+p)"
      />
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
