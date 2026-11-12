import { Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { ToolCardEntry } from "../tui-state.js";
import { stepNoteLine } from "./step-note.js";

/**
 * The `/verbose` row under a finished tool card (ATO-34): one dim,
 * truncated line, so it costs exactly one row (`estimateToolCardHeight`
 * charges it).
 */
export function ToolCardStepNote({
  card,
}: {
  card: ToolCardEntry;
}): ReactElement {
  return (
    <Text color={theme.colors.muted} dimColor wrap="truncate-end">
      {theme.glyphs.toolBoxVertical} {stepNoteLine(card)}
    </Text>
  );
}
