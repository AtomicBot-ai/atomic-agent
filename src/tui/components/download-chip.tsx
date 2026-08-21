import { Text } from "ink";
import type { ReactElement } from "react";
import { formatEta, useTransferRate } from "../hooks/use-transfer-rate.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import { theme } from "../theme/theme.js";

const BAR_WIDTH = 10;

/**
 * A model pull, reported from the one row that is always on screen.
 *
 * The download survives the screen that started it — the orchestrator is
 * session-scoped — but until now it was only ever drawn inside the LLM
 * panel, so an operator who left that tab (or who jumped straight to the
 * agent from setup) had a multi-gigabyte transfer running with nothing
 * anywhere saying so.
 */
export function DownloadChip({ pull }: { pull: LocalModelsPullState }): ReactElement {
  const { etaSeconds } = useTransferRate(pull.transferredBytes, pull.totalBytes);
  const percent = Math.min(100, Math.max(0, Math.round(pull.percent)));
  const filled = Math.round((percent / 100) * BAR_WIDTH);
  const label = pull.kind === "backend" ? "llama.cpp" : String(pull.modelId);
  return (
    <Text wrap="truncate">
      <Text color={theme.colors.accent}>{"  ⇣ "}</Text>
      <Text color={theme.colors.muted}>{label} </Text>
      <Text color={theme.colors.accent}>{"█".repeat(filled)}</Text>
      <Text color={theme.colors.border}>{"░".repeat(BAR_WIDTH - filled)}</Text>
      <Text color={theme.colors.muted}>{` ${percent}%`}</Text>
      {etaSeconds !== null ? (
        <Text color={theme.colors.muted}>{`  ${formatEta(etaSeconds)}`}</Text>
      ) : null}
    </Text>
  );
}
