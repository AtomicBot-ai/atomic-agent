import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { OnboardingFit } from "../onboarding/onboarding-fit.js";
import { ONBOARDING_CHOICES } from "../onboarding/onboarding-state.js";
import { theme } from "../theme/theme.js";

/**
 * The one decision the flow actually needs: where the model runs. The
 * copy describes a choice rather than reporting the failed health probe
 * that used to bring this screen up — a fresh install has nothing broken
 * about it, and "llama-server not reachable" as the first line a new user
 * reads says otherwise.
 */
export function OnboardingChooseStep(props: {
  cursor: number;
  fit: OnboardingFit;
}): ReactElement {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {props.fit.explainer ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.colors.muted}>
            atomic-agent can drive models three ways. Nothing here is permanent —
          </Text>
          <Text color={theme.colors.muted}>
            you can add the others at any time from the menu.
          </Text>
        </Box>
      ) : null}
      {ONBOARDING_CHOICES.map((choice, idx) => {
        const selected = idx === props.cursor;
        return (
          <Box key={choice.id} flexDirection="column">
            <Text color={selected ? theme.colors.accent : undefined} bold={selected}>
              {selected ? "› " : "  "}
              {`[${idx + 1}] `}
              {choice.label}
            </Text>
            {props.fit.rowDetails ? (
              <Text color={theme.colors.muted}>{`        ${choice.detail}`}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
