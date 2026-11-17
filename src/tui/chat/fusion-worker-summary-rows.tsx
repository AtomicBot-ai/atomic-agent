import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { FusionLiveWorker } from "../fusion-live-workers.js";
import { formatCollapsedFusionWorker } from "../fusion-worker-summary.js";
import { theme } from "../theme/theme.js";

/**
 * The last fan-out's workers under the reply, one collapsed row each,
 * once the turn is over (`collapseFusionLiveWorkers`). Muted and
 * truncating: it is a record, not something to act on.
 */
export function FusionWorkerSummaryRows({
  workers,
}: {
  workers: readonly FusionLiveWorker[];
}): ReactElement | null {
  const rows = workers.filter((w) => w.collapsed === true);
  if (rows.length === 0) return null;
  return (
    <Box marginLeft={3} marginTop={1} flexDirection="column">
      {rows.map((worker) => (
        <Box key={worker.taskId} marginLeft={2}>
          <Text color={theme.colors.muted}>· </Text>
          <Text color={theme.colors.muted} wrap="truncate">
            {formatCollapsedFusionWorker(worker)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

/** Rows the summary takes, for the chat log's first-paint estimate. */
export function fusionWorkerSummaryHeight(
  workers: readonly FusionLiveWorker[],
): number {
  const n = workers.filter((w) => w.collapsed === true).length;
  return n === 0 ? 0 : n + 1;
}
