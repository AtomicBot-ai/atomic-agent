import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { AppendLocalPrompt } from "./append-local-question-state.js";

/**
 * One-time question for people who had "local model as the last-resort
 * fallback" turned on before v0.7.0 (ATO-1461). Stacks above the editor
 * like the folder trust question.
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
      <Text color={theme.colors.muted}>y = keep · n = turn off (remembered) · Esc = ask next time</Text>
    </Box>
  );
}
