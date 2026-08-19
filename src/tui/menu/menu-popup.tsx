import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { chromeTheme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import type { MenuItemRow, MenuRow } from "./menu-selectors.js";
import {
  clampMenuCursor,
  selectMenuRows,
  selectMenuTitle,
} from "./menu-selectors.js";
import { MENU_LEADER_LABEL } from "./menu-keys.js";

/** Rows of list body. Keeps the popup shorter than a short terminal. */
const MAX_ROWS = 16;

interface MenuPopupProps {
  state: TuiState;
}

/**
 * The operator menu: one key (`ctrl+p`) to every destination and every verb.
 *
 * Rendered directly above the prompt on the same left rail rather than as a
 * full-screen takeover, so it reads as belonging to the input you were
 * already typing in. The app behind it is dimmed by `setBackdropDimmed`
 * (see `theme.ts`) — this component reads {@link chromeTheme}, which ignores
 * that flag, so the menu stays at full contrast against a faded backdrop.
 *
 * Pure presentation: every key is handled by `handleMenuKey`.
 */
export function MenuPopup({ state }: MenuPopupProps): ReactElement {
  const rows = selectMenuRows(state);
  const cursor = clampMenuCursor(state, state.menuCursor);
  const itemIndexes = rows.flatMap((row, idx) => (row.kind === "item" ? [idx] : []));
  const cursorRowIdx = itemIndexes[cursor] ?? -1;
  const start = windowStart(rows, cursorRowIdx);
  const visible = rows.slice(start, start + MAX_ROWS);
  const hiddenAfter = Math.max(0, rows.length - start - visible.length);

  return (
    <Box
      borderStyle="round"
      borderColor={chromeTheme.colors.accent}
      paddingX={1}
      flexDirection="column"
      flexShrink={0}
    >
      <Box>
        <Text color={chromeTheme.colors.accentSoft} bold>
          {selectMenuTitle(state)}
        </Text>
        <Text color={chromeTheme.colors.muted}>
          {"  "}
          {chromeTheme.glyphs.promptCaret} {state.menuQuery}
          <Text color={chromeTheme.colors.accent}>{"█"}</Text>
        </Text>
      </Box>
      {start > 0 ? (
        <Text color={chromeTheme.colors.muted}>{"↑"} {start} above</Text>
      ) : null}
      {visible.map((row, idx) =>
        row.kind === "header" ? (
          <Text key={`h-${row.label}-${idx}`} color={chromeTheme.colors.muted}>
            {row.label.toUpperCase()}
          </Text>
        ) : (
          <MenuItem
            key={row.node.id}
            row={row}
            selected={start + idx === cursorRowIdx}
          />
        ),
      )}
      {hiddenAfter > 0 ? (
        <Text color={chromeTheme.colors.muted}>
          {"↓"} {hiddenAfter} below
        </Text>
      ) : null}
      {rows.length === 0 ? (
        <Text color={chromeTheme.colors.warn}>nothing matches</Text>
      ) : null}
      <Text color={chromeTheme.colors.muted}>{footer(state)}</Text>
    </Box>
  );
}

function MenuItem({
  row,
  selected,
}: {
  row: MenuItemRow;
  selected: boolean;
}): ReactElement {
  const { node } = row;
  const isSubmenu = node.kind === "submenu";
  const detail = [row.crumb, row.status].filter((part) => part.length > 0).join("  ");
  return (
    <Box>
      <Box flexShrink={0} width={26}>
        <Text
          color={selected ? chromeTheme.colors.accentSoft : undefined}
          bold={selected}
        >
          {selected ? chromeTheme.glyphs.chevronRight : " "} {node.label}
          {isSubmenu ? ` ${chromeTheme.glyphs.arrowRight}` : ""}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text color={chromeTheme.colors.muted}>{detail}</Text>
      </Box>
      {node.chord ? (
        <Box flexShrink={0}>
          <Text color={chromeTheme.colors.muted}>
            {MENU_LEADER_LABEL} {node.chord}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Footer names exactly the moves that are legal right now — `←` only appears
 * once there is a level to go back to.
 */
function footer(state: TuiState): string {
  const parts = [`${"↑↓"} move`];
  if (state.menuQuery.trim().length === 0 && state.menuPath !== null) {
    parts.push(`${"←"} back`);
  }
  if (state.menuQuery.trim().length === 0 && state.menuPath === null) {
    parts.push(`${"→"} open`);
  }
  parts.push("enter go", "type to search", "esc close");
  return parts.join("   ");
}

/** Scroll window that keeps the cursor row visible. */
function windowStart(rows: readonly MenuRow[], cursorRowIdx: number): number {
  if (rows.length <= MAX_ROWS || cursorRowIdx < 0) return 0;
  if (cursorRowIdx < MAX_ROWS) return 0;
  return Math.min(cursorRowIdx - MAX_ROWS + 1, rows.length - MAX_ROWS);
}
