import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { showsCoreFailureNotice, type LocalModelsPanelState } from "./local-models-panel-state.js";

/** Rows the notice takes, for the panel's height budget. */
export const CORE_FAILURE_NOTICE_ROWS = 6;

/**
 * Atomic Core could not be installed or started: what happened, and the
 * one way forward (download again). Never a dead end, never a silent failure.
 */
export function CoreFailureNotice({ panel }: { panel: LocalModelsPanelState }): ReactElement | null {
  const failure = panel.coreFailure;
  if (!failure || !showsCoreFailureNotice(panel)) return null;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="red"
      paddingX={1}
      marginBottom={1}
      width="100%"
    >
      <Text bold color="red">
        ⚠ Atomic Chat engine is not available
      </Text>
      <Text>{failure.reason}</Text>
      <Text>
        <Text bold color="green">
          (R)
        </Text>{" "}
        download again{failure.retryable ? "" : " (may fail the same way)"}
      </Text>
    </Box>
  );
}
