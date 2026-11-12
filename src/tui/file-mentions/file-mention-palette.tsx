import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MouseListRow } from "../mouse/mouse-list-row.js";
import { theme } from "../theme/theme.js";

export interface FileMentionPaletteProps {
  /** `null` while the first listing is still being built. */
  results: readonly string[] | null;
  cursor: number;
  /** A click on an unselected row: move the cursor there. */
  onSelect?: (row: number) => void;
  /** A click on the selected row: complete it, as Tab does. */
  onActivate?: () => void;
}

const MAX_ROWS = 6;

/**
 * The `@` completions, drawn above the composer where the slash palette
 * sits. Pure presentation: the keys (↑↓ move, Tab / Enter / → complete,
 * Esc close) are routed by the app shell, the state is
 * `useFileMentions`. Clicks follow every list: the first selects, a
 * second on the selected row completes it.
 */
export function FileMentionPalette(props: FileMentionPaletteProps): ReactElement {
  const { results } = props;
  if (results === null || results.length === 0) {
    return (
      <Box borderStyle="round" borderColor={theme.colors.muted} paddingX={1} flexShrink={0}>
        <Text color={theme.colors.muted}>
          {results === null ? "listing files…" : "no matching file"}
        </Text>
      </Box>
    );
  }
  const cursor = Math.max(0, Math.min(props.cursor, results.length - 1));
  const start = mentionWindowStart(cursor, results.length, MAX_ROWS);
  const visible = results.slice(start, start + MAX_ROWS);
  const after = results.length - start - visible.length;
  return (
    <Box borderStyle="round" borderColor={theme.colors.accent} paddingX={1} flexDirection="column" flexShrink={0}>
      {start > 0 ? <Text color={theme.colors.muted}>↑ {start} above</Text> : null}
      {visible.map((path, idx) => {
        const selected = start + idx === cursor;
        return (
          <MouseListRow
            key={path}
            selected={selected}
            onSelect={() => props.onSelect?.(start + idx)}
            onActivate={() => props.onActivate?.()}
          >
            <Text
              wrap="truncate-middle"
              color={selected ? theme.colors.accentSoft : theme.colors.muted}
              bold={selected}
            >
              {selected ? theme.glyphs.chevronRight : " "} @{path}
            </Text>
          </MouseListRow>
        );
      })}
      {after > 0 ? <Text color={theme.colors.muted}>↓ {after} below</Text> : null}
    </Box>
  );
}

/** Scroll window that keeps `cursor` in view (same rule as the slash palette). */
export function mentionWindowStart(cursor: number, total: number, size: number): number {
  if (total <= size || cursor < size) return 0;
  return Math.min(cursor - size + 1, total - size);
}
