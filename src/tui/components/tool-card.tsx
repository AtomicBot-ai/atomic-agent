import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import {
  formatToolArgsBlock,
  previewToolArgs,
} from "../render/tool-args-preview.js";
import { theme } from "../theme/theme.js";
import type { StreamingToolCall, ToolCardEntry } from "../tui-state.js";

interface ToolCardProps {
  card: ToolCardEntry | StreamingToolCall;
  expanded: boolean;
}

/**
 * Collapsible tool execution card. Collapsed view is one highlighted
 * header line: name, status glyph, duration, args preview. Expanded view
 * reveals the full args block and the full summary/details text. Pending
 * (in-flight) calls render with a spinner-less hourglass glyph and no
 * duration yet.
 *
 * Clicking the header line toggles the card. Until now the per-card
 * toggle existed in the reducer but had no key binding at all — only
 * `/expand` and `/collapse`, which act on every card at once — so the
 * mouse is the first way to open one specific card.
 */
export function ToolCard({ card, expanded }: ToolCardProps): ReactElement {
  const isFinalised = "status" in card;
  const status = isFinalised ? card.status : "pending";
  const color = toColor(status);
  const glyph = toGlyph(status);
  const argsPreview = previewToolArgs(card.args);
  const duration = isFinalised && card.finishedAt
    ? `${card.finishedAt - card.startedAt}ms`
    : "…";
  const header = (
    <ExpandToggle cardId={card.id}>
    <Text>
      <Text color={color}>
        {theme.glyphs.toolBoxTopLeft}
        {theme.glyphs.toolBoxHorizontal} {glyph} {card.tool}
      </Text>
      <Text color={theme.colors.muted}>
        {" "}
        {theme.glyphs.dotSeparator} {duration}
      </Text>
      {isFinalised && card.truncated ? (
        <Text color={theme.colors.warn}>
          {" "}
          {theme.glyphs.dotSeparator} truncated
        </Text>
      ) : null}
      {argsPreview ? (
        <Text color={theme.colors.muted}>
          {"  "}
          {argsPreview}
        </Text>
      ) : null}
    </Text>
    </ExpandToggle>
  );
  if (!expanded) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {header}
        {isFinalised ? <SummaryLine summary={card.summary} color={color} /> : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      {header}
      <Box flexDirection="column" marginLeft={2}>
        <Text color={theme.colors.muted}>args</Text>
        {splitLines(formatToolArgsBlock(card.args)).map((line, idx) => (
          <Text key={`a-${idx}`}>  {line}</Text>
        ))}
        {isFinalised ? (
          <>
            <Text color={theme.colors.muted}>result</Text>
            {splitLines(card.summary).map((line, idx) => (
              <Text key={`s-${idx}`} color={color}>
                {"  "}
                {line}
              </Text>
            ))}
          </>
        ) : (
          <Text color={theme.colors.muted}>(pending)</Text>
        )}
      </Box>
    </Box>
  );
}

const PREVIEW_SUMMARY_LIMIT = 160;

function SummaryLine({
  summary,
  color,
}: {
  summary: string;
  color: string;
}): ReactElement | null {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return null;
  const oneLine = trimmed.replace(/\s+/g, " ");
  const clipped =
    oneLine.length <= PREVIEW_SUMMARY_LIMIT
      ? oneLine
      : `${oneLine.slice(0, PREVIEW_SUMMARY_LIMIT - 1)}…`;
  return (
    <Text color={color}>
      {theme.glyphs.toolBoxBottomLeft}
      {theme.glyphs.toolBoxHorizontal} {clipped}
    </Text>
  );
}

function toColor(status: "pending" | "ok" | "error"): string {
  switch (status) {
    case "ok":
      return theme.colors.toolOk;
    case "error":
      return theme.colors.toolError;
    default:
      return theme.colors.tool;
  }
}

function toGlyph(status: "pending" | "ok" | "error"): string {
  switch (status) {
    case "ok":
      return theme.glyphs.check;
    case "error":
      return theme.glyphs.cross;
    default:
      return theme.glyphs.chevronRight;
  }
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Wraps the card header so a click folds / unfolds that one card.
 * Transparent when the mouse layer is absent.
 */
function ExpandToggle({
  cardId,
  children,
}: {
  cardId: string;
  children: ReactNode;
}): ReactElement {
  const mouse = useMouseCommands();
  if (!mouse) return <>{children}</>;
  return (
    <MouseTarget
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        mouse.dispatch({ type: "tool_expand_toggled", toolCardId: cardId });
        return true;
      }}
    >
      {children}
    </MouseTarget>
  );
}
