import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";

import {
  MouseTarget,
  useMouseCommands,
  useMouseTarget,
  type MouseContextValue,
} from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { plainKey } from "../mouse/synthetic-key.js";
import { fitToWidth } from "../components/fit-to-width.js";
import { PasteFieldTarget } from "../context-menu/paste-field-target.js";
import { chromeTheme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import type { MenuNode } from "./menu-registry.js";
import type { MenuItemRow } from "./menu-selectors.js";
import {
  clampMenuCursor,
  selectMenuRows,
  selectMenuTitle,
} from "./menu-selectors.js";
import { handleMenuKey, MENU_LEADER_LABEL } from "./menu-keys.js";

/** Popup width, clamped to the terminal on narrow windows. */
const PREFERRED_WIDTH = 64;
/** Rows of list body at most, before the window starts scrolling. */
const MAX_BODY_ROWS = 16;
/** Border (2) + title row + the footer's hairline + footer row. */
const CHROME_ROWS = 5;
/** Column reserved for the entry label. */
const LABEL_WIDTH = 26;

interface MenuPopupProps {
  state: TuiState;
  /** Rows available in the pane the menu floats over. */
  availableRows: number;
  /** Columns available in that pane. */
  availableColumns: number;
  /**
   * Runs a node. The very same callback `handleMenuKey` fires on Enter —
   * passed down rather than reached through the mouse context so a click
   * and a keypress cannot drift into two different activation paths.
   */
  onActivate: (node: MenuNode) => void;
}

/**
 * The operator menu: one key (`ctrl+p`) to every destination and every verb.
 *
 * Rendered as a true overlay — `position="absolute"` inside the content pane,
 * so it floats **on top of** the chat log or the active panel instead of
 * displacing them. Nothing below it reflows when the menu opens or closes.
 *
 * It sits **centred** in that pane, both axes. A dropdown hanging off the
 * prompt was the first shape, but this is not a dropdown: it is the app's
 * one modal surface, and a modal belongs in the middle of the window with
 * the app faded behind it — the same thing a web app would do.
 *
 * Terminals have no compositing and Ink has no z-index, so occlusion has to
 * be earned: every interior line is padded to the popup's exact inner width,
 * which paints spaces over whatever was underneath. That is also why the rows
 * are laid out as fixed-width columns rather than with `flexGrow` — a flexed
 * row stops at its content and lets the background show through.
 *
 * The redesign gives the panel a ground of its own, so the padding now
 * carries a colour too: `railBackground` / `railForeground`, the pair every
 * palette already guarantees to be opposite. Picking a literal colour is what
 * the old comment here refused to do, and rightly — a role is not a literal,
 * and it flips polarity with the theme.
 *
 * The app behind is dimmed by `setBackdropDimmed` (see `theme.ts`); this
 * component reads {@link chromeTheme}, which ignores that flag, so the menu
 * stays at full contrast against a faded backdrop.
 *
 * Pure presentation: every key is handled by `handleMenuKey`.
 */
export function MenuPopup({
  state,
  availableRows,
  availableColumns,
  onActivate,
}: MenuPopupProps): ReactElement {
  const width = Math.max(28, Math.min(PREFERRED_WIDTH, availableColumns - 2));
  // Interior columns between the two border columns. Ink's own `paddingX`
  // is NOT painted by our rows — it leaves real gaps the backdrop shows
  // through — so the one-column gutter is baked into every string instead.
  const inner = width - 2;

  const rows = selectMenuRows(state);
  const cursor = clampMenuCursor(state, state.menuCursor);
  const itemIndexes = rows.flatMap((row, idx) => (row.kind === "item" ? [idx] : []));
  const cursorRowIdx = itemIndexes[cursor] ?? -1;

  const bodyRows = Math.max(
    3,
    Math.min(MAX_BODY_ROWS, availableRows - CHROME_ROWS),
  );
  const start = windowStart(rows.length, cursorRowIdx, bodyRows);
  const visible = rows.slice(start, start + bodyRows);
  const hiddenAfter = Math.max(0, rows.length - start - visible.length);

  // Centred in the pane on both axes.
  const height = visible.length + CHROME_ROWS;
  const offsetTop = Math.max(0, Math.floor((availableRows - height) / 2));
  const offsetLeft = Math.max(0, Math.floor((availableColumns - width) / 2));

  const itemCount = itemIndexes.length;
  return (
    <PopupFrame
      offsetTop={offsetTop}
      offsetLeft={offsetLeft}
      width={width}
      cursor={cursor}
      itemCount={itemCount}
    >
      <TitleRow state={state} inner={inner} onActivate={onActivate} />
      {visible.map((row, idx) =>
        row.kind === "header" ? (
          <Text key={`h-${row.label}-${idx}`} color={chromeTheme.colors.railMuted}>
            {fitToWidth(` ${row.label.toUpperCase()}`, inner)}
          </Text>
        ) : (
          <MenuItem
            key={row.node.id}
            row={row}
            inner={inner}
            selected={start + idx === cursorRowIdx}
            itemIndex={itemIndexes.indexOf(start + idx)}
            onActivate={onActivate}
          />
        ),
      )}
      {rows.length === 0 ? (
        <Text color={chromeTheme.colors.warn}>{fitToWidth(" nothing matches", inner)}</Text>
      ) : null}
      <Text color={chromeTheme.colors.railMuted}>
        {chromeTheme.glyphs.toolBoxHorizontal.repeat(Math.max(0, inner))}
      </Text>
      <Text color={chromeTheme.colors.railMuted}>
        {fitToWidth(` ${footer(state, hiddenAfter)}`, inner)}
      </Text>
    </PopupFrame>
  );
}

/**
 * The popup's own box, plus the mouse behaviour that belongs to the
 * panel rather than to any one row:
 *
 * - **Wheel** walks the cursor. The visible window is derived from the
 *   cursor, so moving it *is* scrolling — one notch, one row, the same
 *   as ↑/↓, which keeps the wheel and the keys on one model.
 * - **Press** is claimed and dropped. Clicking the border, the title or
 *   the footer must not fall through to the backdrop, which closes the
 *   menu: a click inside the panel that shuts it would be the opposite
 *   of what the operator meant.
 *
 * Row targets are smaller boxes on the same layer, so the registry
 * offers them the event first (see `MouseTargetRegistry.dispatch`).
 */
function PopupFrame({
  offsetTop,
  offsetLeft,
  width,
  cursor,
  itemCount,
  children,
}: {
  offsetTop: number;
  offsetLeft: number;
  width: number;
  cursor: number;
  itemCount: number;
  children: ReactNode;
}): ReactElement {
  const mouse = useMouseCommands();
  // The ref goes on the popup box itself rather than on a `MouseTarget`
  // wrapper: the box is absolutely positioned, and an extra Box between
  // it and the pane would take the offsets with it.
  const ref = useMouseTarget(
    (hit) => {
      if (!mouse) return false;
      if (hit.event.kind === "wheel") {
        moveMenuCursor(
          mouse,
          hit.event.wheel === "up" ? -1 : 1,
          cursor,
          itemCount,
        );
        return true;
      }
      return isPrimaryPress(hit.event);
    },
    { layer: MOUSE_LAYER_MODAL },
  );
  return (
    <Box
      ref={ref}
      position="absolute"
      marginTop={offsetTop}
      marginLeft={offsetLeft}
      borderStyle="round"
      borderColor={chromeTheme.colors.railMuted}
      backgroundColor={chromeTheme.colors.railBackground}
      width={width}
      flexDirection="column"
    >
      {children}
    </Box>
  );
}

/** One wheel notch, clamped — the list does not wrap on ↑/↓ either. */
function moveMenuCursor(
  mouse: MouseContextValue,
  delta: number,
  _cursor: number,
  itemCount: number,
): void {
  if (itemCount === 0) return;
  // Read the cursor LIVE, not from the render closure. `createMouseStdin`
  // forwards every report decoded from one stdin read in a synchronous
  // loop, so a trackpad flick delivers several notches before React
  // re-renders — and each one would otherwise compute the same
  // destination from the same stale index, moving the cursor one row for
  // the whole gesture.
  const current = clampMenuCursor(mouse.getState(), mouse.getState().menuCursor);
  const next = Math.max(0, Math.min(itemCount - 1, current + delta));
  if (next === current) return;
  mouse.dispatch({ type: "menu_cursor_set", cursor: next });
}

function TitleRow({
  state,
  inner,
  onActivate,
}: {
  state: TuiState;
  inner: number;
  onActivate: (node: MenuNode) => void;
}): ReactElement {
  // Upper case, matching the rail's own section headers — the menu is
  // chrome, and the design sets every chrome heading the same way.
  const title = selectMenuTitle(state).toUpperCase();
  const caret = `${chromeTheme.glyphs.promptCaret} ${state.menuQuery}`;
  const left = fitToWidth(` ${title}`, Math.min(title.length + 2, inner));
  const rest = inner - left.length;
  return (
    // Right-click paste types into the search query through the menu's
    // own key layer — a text burst appends, it can never activate.
    // `insideOverlay`: the query field IS the open menu.
    <PasteFieldTarget
      insideOverlay
      onPasteText={(text, mouse) => {
        handleMenuKey(text, plainKey(), {
          state: mouse.getState(),
          dispatch: mouse.dispatch,
          activate: onActivate,
        });
      }}
    >
      <Text color={chromeTheme.colors.railForeground} bold>
        {left}
      </Text>
      <Text color={chromeTheme.colors.railMuted}>
        {fitToWidth(caret, Math.max(0, rest))}
      </Text>
    </PasteFieldTarget>
  );
}

function MenuItem({
  row,
  inner,
  selected,
  itemIndex,
  onActivate,
}: {
  row: MenuItemRow;
  inner: number;
  selected: boolean;
  /** Index among the *item* rows — what `menuCursor` counts. */
  itemIndex: number;
  onActivate: (node: MenuNode) => void;
}): ReactElement {
  const mouse = useMouseCommands();
  const { node } = row;
  const marker = selected ? chromeTheme.glyphs.menuCursor : " ";
  const arrow = node.kind === "submenu" ? ` ${chromeTheme.glyphs.arrowRight}` : "";
  // Leading and trailing space are part of the row, not Box padding, so the
  // whole line is opaque edge to edge.
  const label = fitToWidth(` ${marker} ${node.label}${arrow}`, Math.min(LABEL_WIDTH, inner));
  // The shortcut is flush right, as drawn: it is a column the eye scans
  // down, so it cannot float behind a label of whatever length.
  const chordText = node.chord ? `${MENU_LEADER_LABEL} ${node.chord} ` : "";
  const chordWidth = Math.min(chordText.length, Math.max(0, inner - label.length));
  const chord = chordText.padStart(chordWidth).slice(0, chordWidth);
  const detailWidth = Math.max(0, inner - label.length - chordWidth);
  const detail = fitToWidth(
    [row.crumb, row.status].filter((part) => part.length > 0).join("  "),
    detailWidth,
  );
  const body = (
    <>
      {/*
        Selection is weight plus the marker, not a second colour: on a
        painted panel a colour swap either fights the ground or is too
        faint to see, and the marker is the part that survives NO_COLOR.
      */}
      <Text color={chromeTheme.colors.railForeground} bold={selected}>
        {label}
      </Text>
      <Text color={chromeTheme.colors.railMuted}>{detail}</Text>
      <Text color={chromeTheme.colors.railMuted}>{chord}</Text>
    </>
  );
  if (!mouse) return <Box>{body}</Box>;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_MODAL}
      onMouse={(hit) => {
        // Let a wheel notch fall through to the backdrop, which owns
        // scrolling for the whole popup.
        if (hit.event.kind === "wheel") return false;
        if (!isPrimaryPress(hit.event)) return false;
        // One click acts, the way a menu item does everywhere else. The
        // rest of the mouse layer selects first and acts on the second
        // click, because there a mis-click starts a download or switches
        // sessions. Here the operator opened a menu to pick something —
        // making them click twice would be the surprising choice.
        if (itemIndex >= 0) {
          mouse.dispatch({ type: "menu_cursor_set", cursor: itemIndex });
        }
        if (node.kind === "submenu") {
          mouse.dispatch({ type: "menu_path_set", path: node.id });
          return true;
        }
        mouse.dispatch({ type: "menu_closed" });
        onActivate(node);
        return true;
      }}
    >
      {body}
    </MouseTarget>
  );
}

/**
 * Footer names exactly the moves that are legal right now — `←` only appears
 * once there is a level to go back to, `→` only while one is reachable.
 */
function footer(state: TuiState, hiddenAfter: number): string {
  const searching = state.menuQuery.trim().length > 0;
  const parts = ["↑↓ move"];
  if (!searching && state.menuPath !== null) parts.push("← back");
  if (!searching && state.menuPath === null) parts.push("→ open");
  parts.push("enter go", "esc close");
  if (hiddenAfter > 0) parts.push(`↓ ${hiddenAfter} more`);
  return parts.join("   ");
}

/**
 * Pad or truncate to exactly `width` columns. Every interior line goes
 * through this — it is what makes the popup opaque.
 */
/** Scroll window that keeps the cursor row visible. */
function windowStart(total: number, cursorRowIdx: number, size: number): number {
  if (total <= size || cursorRowIdx < 0) return 0;
  if (cursorRowIdx < size) return 0;
  return Math.min(cursorRowIdx - size + 1, total - size);
}
