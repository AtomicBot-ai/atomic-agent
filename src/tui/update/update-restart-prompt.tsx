import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

/**
 * Shown after a self-update settles successfully (`updateStatus === "done"`).
 * The new binary is already installed in place; the running process still
 * executes the old image, so any key press re-execs the freshly-installed
 * binary (see `tui-command` restart handoff). Rendering matches the other
 * inline modals so it stacks naturally above the editor.
 */
export function UpdateRestartPrompt(): ReactElement {
  return (
    <Box
      borderStyle="round"
      borderColor={theme.colors.accent}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={theme.colors.accent} bold>
        update complete
      </Text>
      <Text color={theme.colors.muted}>press any key to restart</Text>
    </Box>
  );
}
