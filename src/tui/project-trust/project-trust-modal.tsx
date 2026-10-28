import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { ProjectTrustPrompt } from "./project-trust-state.js";

/**
 * One-time question about what the opened folder ships (ATO-298): its
 * project skills and AGENTS.md/CLAUDE.md files stay unloaded until the
 * operator answers. Stacks above the editor like the update offer.
 */
export function ProjectTrustModal(props: { prompt: ProjectTrustPrompt }): ReactElement {
  const { prompt } = props;
  return (
    <Box borderStyle="round" borderColor={theme.colors.warn} paddingX={1} flexDirection="column">
      <Text color={theme.colors.warn} bold>
        project folder
      </Text>
      <Text>{prompt.question}</Text>
      <Text color={theme.colors.muted}>{prompt.workingDir}</Text>
      <Text color={theme.colors.muted}>y = trust · n = don't trust (remembered) · Esc = ask next time</Text>
    </Box>
  );
}
