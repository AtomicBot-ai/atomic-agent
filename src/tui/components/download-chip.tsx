import { Text } from "ink";
import type { ReactElement } from "react";
import { formatEta, useTransferRate } from "../hooks/use-transfer-rate.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import { theme } from "../theme/theme.js";

const BAR_WIDTH = 10;

/**
 * Columns each form needs. The status bar is one row and Ink wraps
 * rather than clips, so a chip that does not fit does not get cut off —
 * it turns the header into a paragraph and pushes the whole app down.
 * Hence forms, and a budget, in the same spirit as `hotkey-hint`'s chip
 * shedding.
 */
const FULL_COLUMNS = 46;
const BAR_COLUMNS = 28;
const MINIMAL_COLUMNS = 12;

/**
 * A model pull, reported from the one row that is always on screen.
 *
 * The download survives the screen that started it — the orchestrator is
 * session-scoped — but until now it was only ever drawn inside the LLM
 * panel, so an operator who left that tab (or who jumped straight to the
 * agent from setup) had a multi-gigabyte transfer running with nothing
 * anywhere saying so.
 */
export function DownloadChip({
  pull,
  budget = FULL_COLUMNS,
}: {
  pull: LocalModelsPullState;
  /** Columns left on the status-bar row. Under 12 the chip is dropped. */
  budget?: number;
}): ReactElement | null {
  const { etaSeconds } = useTransferRate(pull.transferredBytes, pull.totalBytes);
  const percent = Math.min(100, Math.max(0, Math.round(pull.percent)));
  const filled = Math.round((percent / 100) * BAR_WIDTH);
  const label = pull.kind === "backend" ? "llama.cpp" : String(pull.modelId);
  if (budget < MINIMAL_COLUMNS) return null;
  const withBar = budget >= BAR_COLUMNS;
  const withEta = budget >= FULL_COLUMNS && etaSeconds !== null;
  return (
    <Text wrap="truncate">
      <Text color={theme.colors.accent}>{"  ⇣ "}</Text>
      {withBar ? <Text color={theme.colors.muted}>{label} </Text> : null}
      {withBar ? (
        <>
          <Text color={theme.colors.accent}>{"█".repeat(filled)}</Text>
          <Text color={theme.colors.border}>{"░".repeat(BAR_WIDTH - filled)}</Text>
        </>
      ) : null}
      <Text color={theme.colors.muted}>{withBar ? ` ${percent}%` : `${percent}%`}</Text>
      {withEta ? (
        <Text color={theme.colors.muted}>{`  ${formatEta(etaSeconds)}`}</Text>
      ) : null}
    </Text>
  );
}
