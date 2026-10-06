import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { useSpinner } from "../hooks/use-spinner.js";
import { theme } from "../theme/theme.js";

/**
 * Inline spinner shown while the self-update `install.sh` is running.
 * Replaces the {@link UpdateModal} once the offer is accepted so the
 * operator gets continuous feedback on the main screen (the verbose
 * `[update] …` lines stream into the Observe feed). Self-cleans when
 * `updateStatus` leaves `running` — the caller renders `null` then.
 */
export function UpdateIndicator(): ReactElement {
  const spinner = useSpinner(true);
  return (
    <Box paddingX={1}>
      <Text color={theme.colors.accent}>{spinner} </Text>
      <Text color={theme.colors.muted}>
        updating atomic-agent… (do not close)
      </Text>
    </Box>
  );
}
