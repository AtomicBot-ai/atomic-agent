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

/** Popup width, clamped to the pane on narrow windows. */
const PREFERRED_WIDTH = 52;
/** Column reserved for the mode name, so the details form a column. */
const LABEL_WIDTH = 22;

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
 * from `plan` to `accept edits`, and nothing on screen said what either
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
  const width = Math.max(24, Math.min(PREFERRED_WIDTH, availableColumns - 2));
  // Interior columns between the two border columns. Ink's `paddingX` is
  // not painted by our rows — it leaves real gaps — so the one-column
  // gutter is baked into every string instead.
  const inner = width - 2;
  // Title and footer are ornament: on a pane too short for them the four
  // rows are what has to survive, because they are the actual content.
  const chromeSlots = Math.min(2, Math.max(0, availableRows - 2 - CODING_MODES.length));
  const showTitle = chromeSlots >= 1;
  const showFooter = chromeSlots >= 2;
  const height = 2 + chromeSlots + CODING_MODES.length;
  return (
    <PopupFrame
      offsetTop={Math.max(0, availableRows - height)}
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

function ModeRow({
  mode,
  inner,
  selected,
  active,
  onActivate,
}: {
  mode: CodingMode;
  inner: number;
  selected: boolean;
  active: boolean;
  onActivate: (mode: CodingMode) => void;
}): ReactElement {
  const look = codingModeLook(mode);
  const marker = selected ? chromeTheme.glyphs.menuCursor : " ";
  const check = active ? `${chromeTheme.glyphs.check} ` : "";
  const label = fitToWidth(
    ` ${marker} ${check}${look.label}`,
    Math.min(LABEL_WIDTH, inner),
  );
  const detail = fitToWidth(
    ` ${look.detail}`,
    Math.max(0, inner - label.length),
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
