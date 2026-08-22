import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";

import { fitToWidth } from "../components/fit-to-width.js";
import {
  MouseTarget,
  useMouseCommands,
  useMouseTarget,
} from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { chromeTheme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import {
  clampComposerSwitchCursor,
  selectComposerSwitchRows,
  selectComposerSwitchTitle,
  type ComposerSwitchRow,
} from "./composer-switch-rows.js";

/** Popup width, clamped to the pane on narrow windows. */
const PREFERRED_WIDTH = 52;
/** Rows of list body at most, before the window starts scrolling. */
const MAX_BODY_ROWS = 10;
/** Column reserved for the entry label when a detail column follows it. */
const LABEL_WIDTH = 24;

export interface ComposerSwitchPopupProps {
  state: TuiState;
  /** Rows available in the pane the switch floats over. */
  availableRows: number;
  /** Columns available in that pane. */
  availableColumns: number;
  /**
   * Runs a row. The very same callback Enter fires — passed down rather
   * than reached through the mouse context so a click and a keypress
   * cannot drift into two different activation paths.
   */
  onActivate: (row: ComposerSwitchRow) => void;
}

/**
 * The overlay behind the composer's three controls.
 *
 * Drawn the way `menu-popup.tsx` is, and for the same reasons: absolute
 * inside the relative content pane so nothing below it reflows, and
 * every interior line padded to the exact inner width, because terminals
 * have no compositing and a row that stops at its content lets the chat
 * log show through it.
 *
 * It differs from the menu in where it sits. The menu is the app's one
 * modal and belongs in the middle of the window; this is a dropdown
 * belonging to a control on the composer's toolbar, so it hangs at the
 * bottom of the pane, directly above the row that opened it. The height
 * is budgeted against `availableRows` for the hazard Ink 7 has no answer
 * to: a frame taller than the terminal overlaps the lines above it
 * instead of being clipped.
 */
export function ComposerSwitchPopup({
  state,
  availableRows,
  availableColumns,
  onActivate,
}: ComposerSwitchPopupProps): ReactElement | null {
  const open = state.composerSwitch;
  if (!open) return null;
  const width = Math.max(24, Math.min(PREFERRED_WIDTH, availableColumns - 2));
  // Interior columns between the two border columns. Ink's own `paddingX`
  // is NOT painted by our rows — it leaves real gaps the backdrop shows
  // through — so the one-column gutter is baked into every string instead.
  const inner = width - 2;

  const rows = selectComposerSwitchRows(state, open.kind);
  const cursor = clampComposerSwitchCursor(state, open.cursor);
  // Optional chrome, shed when the pane cannot hold it: the two border
  // rows and one body row are the floor, and past that the hairline
  // goes first (ornament), then the footer (every key keeps working
  // undocumented), then the filter line, then the title — the title
  // outlives the rest because it names the switch and carries the
  // position counter.
  const chromeSlots = Math.min(4, Math.max(0, availableRows - 3));
  const showTitle = chromeSlots >= 1;
  const showFilter = chromeSlots >= 2;
  const showFooter = chromeSlots >= 3;
  const showHairline = chromeSlots >= 4;
  const bodyRows = Math.max(
    1,
    Math.min(MAX_BODY_ROWS, availableRows - 2 - chromeSlots),
  );
  const start = windowStart(rows.length, cursor, bodyRows);
  const visible = rows.slice(start, start + bodyRows);
  const height = 2 + chromeSlots + Math.max(1, visible.length);
  // `(cursor+1/total)` is the "there is more" affordance: the old
  // footer's `↓ n more` tail was exactly the part `fitToWidth` cut off.
  const counter = `(${rows.length === 0 ? 0 : cursor + 1}/${rows.length})`;

  return (
    <PopupFrame
      offsetTop={Math.max(0, availableRows - height)}
      width={width}
    >
      {showTitle ? (
        <Text color={chromeTheme.colors.railForeground} bold>
          {fitToWidth(
            ` ${selectComposerSwitchTitle(open.kind).toUpperCase()} ${counter}`,
            inner,
          )}
        </Text>
      ) : null}
      {showFilter ? <FilterLine filter={open.filter} inner={inner} /> : null}
      {visible.map((row, idx) => (
        <SwitchRow
          key={row.id}
          row={row}
          inner={inner}
          selected={start + idx === cursor}
          rowIndex={start + idx}
          onActivate={onActivate}
        />
      ))}
      {rows.length === 0 ? (
        <Text color={chromeTheme.colors.warn}>
          {fitToWidth(
            open.filter.length > 0
              ? ` no match for "${open.filter}" — backspace to widen`
              : " nothing to switch to",
            inner,
          )}
        </Text>
      ) : null}
      {showHairline ? (
        <Text color={chromeTheme.colors.railMuted}>
          {chromeTheme.glyphs.toolBoxHorizontal.repeat(Math.max(0, inner))}
        </Text>
      ) : null}
      {showFooter ? (
        <Text color={chromeTheme.colors.railMuted}>
          {fitToWidth(` ${footer(open.filter)}`, inner)}
        </Text>
      ) : null}
    </PopupFrame>
  );
}

/**
 * The filter row under the title. Drawn even before anything is typed —
 * the operator has to see that the list is typeable before they would
 * think to type — and padded to the full inner width like every other
 * line, so the chat log cannot show through it.
 */
function FilterLine({
  filter,
  inner,
}: {
  filter: string;
  inner: number;
}): ReactElement {
  const label = " filter: ";
  if (filter.length === 0) {
    return (
      <Text color={chromeTheme.colors.railMuted}>
        {fitToWidth(`${label}type to filter`, inner)}
      </Text>
    );
  }
  return (
    <Text>
      <Text color={chromeTheme.colors.railMuted}>{label}</Text>
      {/* The query is text being actively read back, so it gets the
          rail's full text tone, not the muted one. */}
      <Text color={chromeTheme.colors.railForeground}>
        {fitToWidth(`${filter}▏`, Math.max(0, inner - label.length))}
      </Text>
    </Text>
  );
}

/**
 * The popup's own box. It claims presses that land on its border, title
 * or footer: a click inside the panel must not fall through to the
 * backdrop, which closes it.
 */
function PopupFrame({
  offsetTop,
  width,
  children,
}: {
  offsetTop: number;
  width: number;
  children: ReactNode;
}): ReactElement {
  // The ref goes on the popup box itself rather than on a `MouseTarget`
  // wrapper: the box is absolutely positioned, and an extra Box between
  // it and the pane would take the offset with it.
  const ref = useMouseTarget((hit) => isPrimaryPress(hit.event), {
    layer: MOUSE_LAYER_MODAL,
  });
  return (
    <Box
      ref={ref}
      position="absolute"
      marginTop={offsetTop}
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

function SwitchRow({
  row,
  inner,
  selected,
  rowIndex,
  onActivate,
}: {
  row: ComposerSwitchRow;
  inner: number;
  selected: boolean;
  rowIndex: number;
  onActivate: (row: ComposerSwitchRow) => void;
}): ReactElement {
  const mouse = useMouseCommands();
  const marker = selected ? chromeTheme.glyphs.menuCursor : " ";
  const check = row.active ? `${chromeTheme.glyphs.check} ` : "";
  // The label column is reserved only when there is a detail column to
  // align: catalog ids differ past column 24, and truncating them
  // against an empty right half made neighbouring rows read identical.
  const labelBudget =
    row.detail.length > 0 ? Math.min(LABEL_WIDTH, inner) : inner;
  const label = fitToWidth(` ${marker} ${check}${row.label}`, labelBudget);
  const detail = fitToWidth(` ${row.detail}`, Math.max(0, inner - label.length));
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
    </>
  );
  if (!mouse) return <Box>{body}</Box>;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_MODAL}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        // One click acts, the way the operator menu's rows do: this list
        // was opened to pick something from it.
        mouse.dispatch({ type: "composer_switch_cursor_set", cursor: rowIndex });
        onActivate(row);
        return true;
      }}
    >
      {body}
    </MouseTarget>
  );
}

/**
 * Two footers, not one: a typed filter changes what Esc does, and each
 * variant is kept short enough to survive `fitToWidth` at the popup's
 * full 50-column interior — the five-part footer this replaces ran to
 * 52 and lost its own tail.
 */
function footer(filter: string): string {
  if (filter.length > 0) {
    return ["↑↓ move", "enter pick", "esc clears, again closes"].join("   ");
  }
  return ["↑↓ move", "←→ switch", "enter pick", "esc close"].join("   ");
}

/** Scroll window that keeps the cursor row visible. */
function windowStart(total: number, cursor: number, size: number): number {
  if (total <= size || cursor < 0) return 0;
  if (cursor < size) return 0;
  return Math.min(cursor - size + 1, total - size);
}
