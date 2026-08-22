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
 *
 * The label-bearing forms price themselves off the label actually
 * drawn instead of off a fixed guess: custom Hugging Face ids run to
 * 87 chars (`custom-<repo>-<file>`, `buildCustomModelId`), and fixed
 * thresholds tuned for `gemma-4-e4b` let those blow the one-row budget.
 */
const MINIMAL_COLUMNS = 12;
/** `"  ⇣ "` — the leading glyph and its breathing room. */
const PREFIX_COLUMNS = 4;
/** Worst-case `"  "` + `formatEta` text ("less than a minute left"). */
const ETA_COLUMNS = 25;
/** What an unbudgeted caller gets: the old FULL-form allowance. */
const DEFAULT_BUDGET = 46;

/**
 * Longest label the chip draws, ellipsis included. Display only — the
 * id the download actions use is never the truncated string.
 */
const MAX_LABEL_COLUMNS = 30;

function capLabel(label: string): string {
  if (label.length <= MAX_LABEL_COLUMNS) return label;
  return `${label.slice(0, MAX_LABEL_COLUMNS - 1)}…`;
}

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
  budget = DEFAULT_BUDGET,
}: {
  pull: LocalModelsPullState;
  /** Columns left on the status-bar row. Under 12 the chip is dropped. */
  budget?: number;
}): ReactElement | null {
  const { etaSeconds } = useTransferRate(pull.transferredBytes, pull.totalBytes);
  const percent = Math.min(100, Math.max(0, Math.round(pull.percent)));
  const filled = Math.round((percent / 100) * BAR_WIDTH);
  const label = capLabel(pull.kind === "backend" ? "llama.cpp" : String(pull.modelId));
  if (budget < MINIMAL_COLUMNS) return null;
  const percentText = `${percent}%`;
  // prefix + label + space + bar + space + percent — what the BAR form
  // costs with THIS label, so a long-but-capped name sheds to the
  // percent-only form on narrow rows instead of overflowing them.
  const barColumns =
    PREFIX_COLUMNS + label.length + 1 + BAR_WIDTH + 1 + percentText.length;
  const withBar = budget >= barColumns;
  const withEta = budget >= barColumns + ETA_COLUMNS && etaSeconds !== null;
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
      <Text color={theme.colors.muted}>{withBar ? ` ${percentText}` : percentText}</Text>
      {withEta ? (
        <Text color={theme.colors.muted}>{`  ${formatEta(etaSeconds)}`}</Text>
      ) : null}
    </Text>
  );
}
