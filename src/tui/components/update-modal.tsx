import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

export interface UpdateModalProps {
  current: string;
  latest: string;
}

/**
 * Y/N offer shown at startup when a newer atomic-agent release is
 * published. Accepting runs the canonical `install.sh`; the running
 * process is not restarted, so the success message asks the user to
 * relaunch. Rendering matches the other inline modals so it stacks
 * naturally above the editor.
 */
export function UpdateModal(props: UpdateModalProps): ReactElement {
  const { current, latest } = props;
  return (
    <Box
      borderStyle="round"
      borderColor={theme.colors.accent}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={theme.colors.accent} bold>
        update available
      </Text>
      <Text>
        <Text color={theme.colors.muted}>current:</Text> v{current}{"  "}
        <Text color={theme.colors.muted}>latest:</Text> v{latest}
      </Text>
      <Text color={theme.colors.muted}>
        y = update now · n / Esc = skip
      </Text>
    </Box>
  );
}
