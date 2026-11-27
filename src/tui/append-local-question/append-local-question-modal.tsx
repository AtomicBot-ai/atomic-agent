import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { APPEND_LOCAL_CHORDS } from "./append-local-question-key-bindings.js";
import type { AppendLocalPrompt } from "./append-local-question-state.js";

/**
 * One-time question for people who had "local model as the last-resort
 * fallback" turned on before v0.7.0 (ATO-1461). Stacks above the editor,
 * which stays live: the answers are chords, so typing is never an
 * answer (ATO-2760).
 */
export function AppendLocalQuestionModal(props: { prompt: AppendLocalPrompt }): ReactElement {
  const { prompt } = props;
  return (
    <Box borderStyle="round" borderColor={theme.colors.warn} paddingX={1} flexDirection="column">
      <Text color={theme.colors.warn} bold>
        fallback
      </Text>
      <Text>{prompt.question}</Text>
      <Text color={theme.colors.muted}>{prompt.detail}</Text>
      <Text color={theme.colors.muted}>
        {`ctrl+${APPEND_LOCAL_CHORDS.keep} keep · ctrl+${APPEND_LOCAL_CHORDS.off} turn off (remembered) · esc ask next time`}
      </Text>
    </Box>
  );
}
