import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

interface QueuedMessagesProps {
  /** Messages the operator submitted while a turn was still running. */
  queued: readonly string[];
  /** Terminal width available to the strip; used to elide long previews. */
  width?: number;
}

/** How many rows we render before collapsing the rest into a counter. */
const MAX_VISIBLE_ROWS = 3;
/** Fallback preview width when the caller does not know the terminal size. */
const DEFAULT_PREVIEW_WIDTH = 60;

/**
 * Dim strip rendered directly above the prompt listing messages that are
 * parked behind the running turn. It exists because the queue used to be
 * invisible: `ChatOrchestrator` has always buffered submissions made while
 * a turn was in flight, but nothing on screen told the operator that their
 * message had been accepted rather than swallowed.
 *
 * Renders nothing when the queue is empty so the prompt does not jump by a
 * row on every turn boundary.
 */
export function QueuedMessages({
  queued,
  width,
}: QueuedMessagesProps): ReactElement | null {
  if (queued.length === 0) return null;
  const previewWidth = Math.max(20, (width ?? DEFAULT_PREVIEW_WIDTH) - 8);
  const visible = queued.slice(0, MAX_VISIBLE_ROWS);
  const hidden = queued.length - visible.length;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {visible.map((text, idx) => (
        <Text key={`queued-${idx}`} color={theme.colors.muted}>
          {"  "}
          {theme.glyphs.dotSeparator} queued: {previewOf(text, previewWidth)}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text color={theme.colors.muted}>
          {"  "}
          {theme.glyphs.dotSeparator} …and {hidden} more queued
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * Single-line preview: newlines become spaces (the strip is one row per
 * message) and anything past `max` is elided.
 */
export function previewOf(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1))}…`;
}
