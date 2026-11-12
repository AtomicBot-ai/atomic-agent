import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";

import type { UserQuestion } from "../approval/user-question.js";
import { theme } from "./theme/theme.js";

/**
 * The TUI's card for an `ask_user` question (ATO-489), drawn in the
 * approval prompt's place. The options are numbered; the composer is the
 * answer field: `2`, `1,3` (several, when the question takes several) or
 * the person's own words, then Enter (`submit-handler.ts`). The approval
 * chords do not apply, except the deny chord, which skips the question.
 */
export function QuestionPrompt({
  question,
  skipButton,
}: {
  question: UserQuestion;
  /** The deny button of the approval prompt, labelled as a skip. */
  skipButton: ReactNode;
}): ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={theme.colors.accent}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={theme.colors.accent}>
        ? question for you
      </Text>
      <Box marginTop={1}>
        <Text bold>{question.prompt}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {question.options.map((option, index) => (
          <Text key={option.label}>
            <Text color={theme.colors.accent} bold>{`${index + 1}. `}</Text>
            {option.label}
            {option.description ? (
              <Text color={theme.colors.muted}>{` - ${option.description}`}</Text>
            ) : null}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="row">
        {skipButton}
      </Box>
      <Text color={theme.colors.muted}>{questionHint(question)}</Text>
    </Box>
  );
}

/** The line under the options: how to answer this particular question. */
export function questionHint(question: UserQuestion): string {
  const pick = question.multiSelect
    ? "type the numbers of your picks (1,3)"
    : "type the number of your pick";
  const own = question.allowOther ? " or your own answer" : "";
  return `${pick}${own} in the composer, then enter`;
}
