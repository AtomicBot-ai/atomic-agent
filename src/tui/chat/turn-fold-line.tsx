import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import {
  turnFoldLineParts,
  type DescribeFoldedCards,
  type TurnFold,
} from "../render/turn-collapse.js";
import { theme } from "../theme/theme.js";

/**
 * The one line a finished turn folds into (ATO-963):
 * `Used 6 tools · 1 failed · 40s ▸`. A click opens the steps under it and
 * a second click folds them again; `/expand` does the same from the
 * keyboard. One row plus the blank row above it: the label truncates, the
 * failure count and the time never do. `estimateMessageHeight` charges the
 * same two rows.
 */
export function TurnFoldLine({
  fold,
  open,
  describe,
}: {
  fold: TurnFold;
  open: boolean;
  describe?: DescribeFoldedCards;
}): ReactElement {
  const parts = turnFoldLineParts(fold, {
    open,
    ...(describe ? { describe } : {}),
  });
  const sep = ` ${theme.glyphs.dotSeparator} `;
  const line = (
    <Box
      flexDirection="row"
      height={1}
      overflow="hidden"
      marginLeft={2}
      marginTop={1}
    >
      <Box flexShrink={1} minWidth={0}>
        <Text color={theme.colors.muted} wrap="truncate-end">
          {parts.label}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text wrap="truncate-end">
          {parts.failed !== null ? (
            <Text color={theme.colors.toolError}>
              {sep}
              {parts.failed}
            </Text>
          ) : null}
          {parts.unfinished !== null ? (
            <Text color={theme.colors.warn}>
              {sep}
              {parts.unfinished}
            </Text>
          ) : null}
          {parts.duration !== null ? (
            <Text color={theme.colors.muted} dimColor>
              {sep}
              {parts.duration}
            </Text>
          ) : null}
          <Text color={theme.colors.muted}> {parts.chevron}</Text>
        </Text>
      </Box>
    </Box>
  );
  return <FoldToggle messageId={fold.messageId}>{line}</FoldToggle>;
}

/** A click on the line opens / folds that one turn. Transparent without a mouse layer. */
function FoldToggle({
  messageId,
  children,
}: {
  messageId: string;
  children: ReactElement;
}): ReactElement {
  const mouse = useMouseCommands();
  if (!mouse) return children;
  return (
    <MouseTarget
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        mouse.dispatch({ type: "turn_expand_toggled", messageId });
        return true;
      }}
    >
      {children}
    </MouseTarget>
  );
}
