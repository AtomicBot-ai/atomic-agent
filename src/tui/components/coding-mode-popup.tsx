import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";

import {
  CODING_MODES,
  codingModeLook,
  type CodingMode,
} from "../coding-mode.js";
import {
  MouseTarget,
  useMouseCommands,
  useMouseTarget,
} from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { chromeTheme } from "../theme/theme.js";
import { fitToWidth } from "./fit-to-width.js";

/**
 * Width of the label column: the longest mode name plus the marker,
 * the check and the two gutter spaces around them. Measured rather
 * than guessed, so renaming a mode cannot silently clip it.
 */
const LABEL_WIDTH =
  Math.max(...CODING_MODES.map((mode) => codingModeLook(mode).label.length)) + 6;

/**
 * The narrowest the menu may get before it stops laying the detail
 * beside the label. Below this the two columns are fighting, and a
 * stacked row reads better than a squeezed one.
 */
const MIN_TWO_COLUMN_WIDTH = 34;

/**
 * Columns the menu needs to show every row in full: the label column
 * plus the longest detail plus its leading space.
 *
 * The menu is sized from its content instead of the content being cut to
 * a fixed width. An explanation with its end shaved off is worse than no
 * explanation — it reads as a rendering bug, and it still does not answer
 * the question the menu exists to answer.
 */
export function codingMenuContentWidth(): number {
  // +1 for the space before the detail, +1 for a trailing gutter so the
  // longest line does not sit flush against the right border, +2 for
  // the border columns themselves.
  const detail =
    Math.max(...CODING_MODES.map((mode) => codingModeLook(mode).detail.length)) +
    2;
  return LABEL_WIDTH + detail + 2;
}

export interface CodingModePopupProps {
  /** Highlighted row, an index into {@link CODING_MODES}. */
  cursor: number;
  /** The mode actually in force, marked with a check. */
  active: CodingMode;
  /** Rows available in the pane the menu floats over. */
  availableRows: number;
  /** Columns available in that pane. */
  availableColumns: number;
  /**
   * Applies a mode. The same callback Enter fires — passed down rather
   * than reached through the mouse context, so a click and a keypress
   * cannot drift into two different activation paths.
   */
  onActivate: (mode: CodingMode) => void;
}

/**
 * The menu behind the composer's mode chip.
 *
 * The chip used to cycle the ring on click. That made the one control in
 * the app that changes what the agent is *allowed to do* also the only
 * one with no confirmation and no explanation: two stray clicks took you
 * from `plan` to `auto`, and nothing on screen said what either
 * of them meant. A menu costs one extra click and buys the four
 * sentences that make the choice a choice.
 *
 * Drawn the way `composer-switch-popup.tsx` is, and for the same reasons:
 * absolutely positioned inside the content pane so nothing below it
 * reflows, hung at the bottom so it sits directly above the control that
 * opened it, and every interior line padded to the exact inner width —
 * a terminal has no compositing, so a row that stops at its content lets
 * the chat log show through it.
 */
export function CodingModePopup({
  cursor,
  active,
  availableRows,
  availableColumns,
  onActivate,
}: CodingModePopupProps): ReactElement {
  // Content-sized, then clamped to the pane. Wanting more room than the
  // terminal has is the one case the detail cannot be shown beside the
  // label, and `stacked` is what handles it — by giving the detail its
  // own line, never by truncating it.
  const wanted = codingMenuContentWidth();
  const width = Math.max(24, Math.min(wanted, availableColumns - 2));
  const stacked = width < Math.min(wanted, MIN_TWO_COLUMN_WIDTH)
    || width < wanted;
  // Interior columns between the two border columns. Ink's `paddingX` is
  // not painted by our rows — it leaves real gaps — so the one-column
  // gutter is baked into every string instead.
  const inner = width - 2;
  // Title and footer are ornament: on a pane too short for them the four
  // rows are what has to survive, because they are the actual content.
  const bodyRows = CODING_MODES.length * (stacked ? 2 : 1);
  const chromeSlots = Math.min(2, Math.max(0, availableRows - 2 - bodyRows));
  const showTitle = chromeSlots >= 1;
  const showFooter = chromeSlots >= 2;
  const height = 2 + chromeSlots + bodyRows;
  return (
    <PopupFrame
      offsetTop={Math.max(0, availableRows - height)}
      // Right-aligned, because the control that opens it is: the chip
      // sits at the far end of the composer's bar, and a menu that
      // dropped from the opposite corner would read as belonging to
      // something else. `ComposerSwitchPopup` hangs left for exactly the
      // same reason — its controls are at the bar's left end.
      offsetLeft={Math.max(0, availableColumns - width)}
      width={width}
    >
      {showTitle ? (
        <Text color={chromeTheme.colors.railForeground} bold>
          {fitToWidth(" CODING MODE", inner)}
        </Text>
      ) : null}
      {CODING_MODES.map((mode, idx) => (
        <ModeRow
          key={mode}
          mode={mode}
          inner={inner}
          selected={idx === cursor}
          active={mode === active}
          stacked={stacked}
          onActivate={onActivate}
        />
      ))}
      {showFooter ? (
        <Text color={chromeTheme.colors.railMuted}>
          {fitToWidth(" ↑↓ move · enter apply · esc cancel", inner)}
        </Text>
      ) : null}
    </PopupFrame>
  );
}

/**
 * The popup's own box. It claims presses that land on its border, title
 * or footer: a click inside the panel must not fall through to the
 * backdrop, which closes it.
 */
function PopupFrame({
  offsetTop,
  offsetLeft,
  width,
  children,
}: {
  offsetTop: number;
  offsetLeft: number;
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

function ModeRow({
  mode,
  inner,
  selected,
  active,
  stacked,
  onActivate,
}: {
  mode: CodingMode;
  inner: number;
  selected: boolean;
  active: boolean;
  /** Detail on its own line, for a pane too narrow for two columns. */
  stacked: boolean;
  onActivate: (mode: CodingMode) => void;
}): ReactElement {
  const look = codingModeLook(mode);
  const marker = selected ? chromeTheme.glyphs.menuCursor : " ";
  const check = active ? `${chromeTheme.glyphs.check} ` : "";
  const labelText = ` ${marker} ${check}${look.label}`;
  /*
    Selection is weight plus the marker, not a second colour: on a
    painted panel a colour swap either fights the ground or is too faint
    to see, and the marker is the part that survives NO_COLOR.
  */
  const body = stacked ? (
    <Box flexDirection="column">
      <Text color={chromeTheme.colors.railForeground} bold={selected}>
        {fitToWidth(labelText, inner)}
      </Text>
      {/*
        Indented under the label rather than beside it. The detail is
        still shown in full — that is the whole point of stacking rather
        than truncating — and `fitToWidth` here only pads it out to the
        panel's ground.
      */}
      <Text color={chromeTheme.colors.railMuted}>
        {fitToWidth(`     ${look.detail}`, inner)}
      </Text>
    </Box>
  ) : (
    <>
      <Text color={chromeTheme.colors.railForeground} bold={selected}>
        {fitToWidth(labelText, Math.min(LABEL_WIDTH, inner))}
      </Text>
      <Text color={chromeTheme.colors.railMuted}>
        {fitToWidth(
          ` ${look.detail}`,
          Math.max(0, inner - Math.min(LABEL_WIDTH, inner)),
        )}
      </Text>
    </>
  );
  const mouse = useMouseCommands();
  if (!mouse) return <Box>{body}</Box>;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_MODAL}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        // One click applies. A first click that only moved the cursor
        // would make the menu a two-click control for no gain — the row
        // under the pointer is already the one being read.
        onActivate(mode);
        return true;
      }}
    >
      {body}
    </MouseTarget>
  );
}
